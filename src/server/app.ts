import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";
import type { PrismaClient } from "../generated/prisma/client";
import { MAX_MESSAGE_BYTES, MAX_POINTS_PER_BOARD, MAX_STROKES_PER_BOARD } from "../shared/limits";
import {
  commitSchema, cursorSchema, joinSchema, progressSchema, roomOf, undoSchema,
  type Ack, type ClientToServerEvents, type ErrorCode, type JoinAck, type ServerToClientEvents,
  type SocketData, type Stroke, type User,
} from "../shared/protocol";

type IoServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type IoSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type Ackfn = ((r: never) => void) | undefined;

export interface WhiteboardServerOptions {
  prisma: PrismaClient;
  /** The single browser origin that may connect. */
  corsOrigin: string;
}

export function createWhiteboardServer({ prisma, corsOrigin }: WhiteboardServerOptions) {
  const httpServer = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(404).end();
  });

  const io: IoServer = new Server(httpServer, {
    cors: { origin: corsOrigin, methods: ["GET", "POST"] },
    maxHttpBufferSize: MAX_MESSAGE_BYTES,
    // Browsers always send Origin; refuse any browser from another origin even on websocket,
    // where CORS itself does not apply. Non-browser clients send no Origin.
    allowRequest: (req, cb) => {
      const origin = req.headers.origin;
      cb(null, origin === undefined || origin === corsOrigin);
    },
  });

  /** boardId -> clientId -> user with the socket ids it currently has open. */
  const presence = new Map<string, Map<string, { name: string; sockets: Set<string> }>>();
  const usersOf = (boardId: string): User[] =>
    [...(presence.get(boardId) ?? [])].map(([id, u]) => ({ id, name: u.name }));

  io.on("connection", (socket) => {
    registerHandlers(socket);
  });

  function registerHandlers(socket: IoSocket) {
    /** Register an event whose first argument is untrusted and whose last argument may be an ack. */
    const on = (event: keyof ClientToServerEvents, handler: (raw: unknown, ack: Ackfn) => Promise<void> | void) => {
      (socket as Socket).on(event, async (...args: unknown[]) => {
        const last = args[args.length - 1];
        const ack = typeof last === "function" ? (last as (r: never) => void) : undefined;
        try {
          await handler(args[0] === ack ? undefined : args[0], ack);
        } catch (err) {
          console.error(`handler ${event} failed:`, err instanceof Error ? err.message : "unknown error");
          ack?.({ ok: false, error: "internal" } as never);
        }
      });
    };
    const fail = (ack: Ackfn, error: ErrorCode) => ack?.({ ok: false, error } as never);
    const done = (ack: Ackfn) => ack?.({ ok: true } as never);
    const ctx = () => {
      const { boardId, clientId, name } = socket.data;
      return boardId && clientId && name ? { boardId, clientId, name, room: roomOf(boardId) } : null;
    };

    on("board:join", async (raw, ack) => {
      const parsed = joinSchema.safeParse(raw);
      if (!parsed.success) return fail(ack, "invalid");
      if (socket.data.boardId || socket.data.joining) return fail(ack, "already_joined");
      socket.data.joining = true;
      const { boardId, clientId, name } = parsed.data;
      const room = roomOf(boardId);
      try {
        const board = await prisma.board.findUnique({ where: { id: boardId }, select: { id: true } });
        if (!board) return fail(ack, "not_found");

        // Join the room before reading history so no live event can fall between the two.
        await socket.join(room);
        let rows;
        try {
          rows = await prisma.stroke.findMany({ where: { boardId }, orderBy: { seq: "asc" } });
        } catch (err) {
          await socket.leave(room);
          throw err;
        }

        socket.data.boardId = boardId;
        socket.data.clientId = clientId;
        socket.data.name = name;

        const board_ = presence.get(boardId) ?? new Map();
        presence.set(boardId, board_);
        const existing = board_.get(clientId);
        if (existing) existing.sockets.add(socket.id);
        else {
          board_.set(clientId, { name, sockets: new Set([socket.id]) });
          socket.to(room).emit("user:joined", { id: clientId, name });
        }

        const strokes: Stroke[] = rows.map((r) => ({
          id: r.id, authorId: r.authorId, color: r.color, width: r.width,
          points: r.points as Stroke["points"],
        }));
        const reply: JoinAck = { ok: true, strokes, users: usersOf(boardId) };
        ack?.(reply as never);
      } finally {
        socket.data.joining = false;
      }
    });

    on("stroke:progress", (raw) => {
      const c = ctx();
      if (!c) return;
      const parsed = progressSchema.safeParse(raw);
      if (!parsed.success) return;
      socket.to(c.room).emit("stroke:progress", { ...parsed.data, authorId: c.clientId });
    });

    on("cursor:move", (raw) => {
      const c = ctx();
      if (!c) return;
      const parsed = cursorSchema.safeParse(raw);
      if (!parsed.success) return;
      socket.to(c.room).volatile.emit("cursor:move", { id: c.clientId, name: c.name, ...parsed.data });
    });

    on("stroke:commit", async (raw, ack) => {
      const c = ctx();
      if (!c) return fail(ack, "not_joined");
      const parsed = commitSchema.safeParse(raw);
      if (!parsed.success) return fail(ack, "invalid");
      const s = parsed.data;

      const outcome = await prisma.$transaction(async (tx) => {
        // One writer per board at a time, so the cap check and the insert cannot interleave.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${c.boardId}, 0))`;
        const existing = await tx.stroke.findUnique({ where: { id: s.id }, select: { boardId: true, authorId: true } });
        if (existing) {
          return existing.boardId === c.boardId && existing.authorId === c.clientId ? "duplicate" : "forbidden";
        }
        const totals = await tx.stroke.aggregate({
          where: { boardId: c.boardId },
          _count: { _all: true },
          _sum: { pointCount: true },
        });
        if (totals._count._all >= MAX_STROKES_PER_BOARD) return "board_full";
        if ((totals._sum.pointCount ?? 0) + s.points.length > MAX_POINTS_PER_BOARD) return "board_full";
        const res = await tx.stroke.createMany({
          data: [{
            id: s.id, boardId: c.boardId, authorId: c.clientId, color: s.color, width: s.width,
            points: s.points, pointCount: s.points.length,
          }],
          skipDuplicates: true,
        });
        // 0 rows means the id was taken by another board between the check and the insert.
        return res.count === 1 ? "created" : "forbidden";
      });

      if (outcome === "board_full") return fail(ack, "board_full");
      if (outcome === "forbidden") return fail(ack, "forbidden");
      if (outcome === "created") socket.to(c.room).emit("stroke:commit", { ...s, authorId: c.clientId });
      done(ack);
    });

    on("stroke:undo", async (raw, ack) => {
      const c = ctx();
      if (!c) return fail(ack, "not_joined");
      const parsed = undoSchema.safeParse(raw);
      if (!parsed.success) return fail(ack, "invalid");
      const res = await prisma.stroke.deleteMany({
        where: { id: parsed.data.id, boardId: c.boardId, authorId: c.clientId },
      });
      if (res.count === 0) return fail(ack, "forbidden");
      socket.to(c.room).emit("stroke:remove", { id: parsed.data.id });
      done(ack);
    });

    on("board:clear", async (_raw, ack) => {
      const c = ctx();
      if (!c) return fail(ack, "not_joined");
      await prisma.stroke.deleteMany({ where: { boardId: c.boardId } });
      socket.to(c.room).emit("board:cleared");
      done(ack);
    });

    socket.on("disconnect", () => {
      const { boardId, clientId } = socket.data;
      if (!boardId || !clientId) return;
      const users = presence.get(boardId);
      const user = users?.get(clientId);
      if (!users || !user) return;
      user.sockets.delete(socket.id);
      if (user.sockets.size === 0) {
        users.delete(clientId);
        if (users.size === 0) presence.delete(boardId);
        io.to(roomOf(boardId)).emit("user:left", { id: clientId });
      }
    });
  }

  return { httpServer, io };
}

export type { Ack };
