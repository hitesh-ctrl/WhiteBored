import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { clientAddress, trustHops } from "../lib/proxy";
import { Server, type Socket } from "socket.io";
import type { PrismaClient } from "../generated/prisma/client";
import {
  MAX_CONNECTIONS_PER_IP, MAX_MESSAGE_BYTES, MAX_POINTS_PER_BOARD, MAX_STROKES_PER_BOARD,
} from "../shared/limits";
import {
  commitSchema, cursorSchema, joinSchema, progressSchema, renameSchema, roomOf, undoSchema,
  type ClientToServerEvents, type ErrorCode, type JoinAck, type Role, type ServerToClientEvents,
  type Point, type SocketData, type Stroke, type User,
} from "../shared/protocol";
import { createBuckets, type LimitKind } from "./rateLimit";

type IoServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type IoSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type Ackfn = ((r: never) => void) | undefined;

export interface WhiteboardServerOptions {
  prisma: PrismaClient;
  /** The single browser origin that may connect. */
  corsOrigin: string;
  /** Connections allowed from one client address at the same time. */
  maxConnectionsPerIp?: number;
  /**
   * How many trusted proxies sit in front of this server (true means 1). Their X-Forwarded-For
   * entries, counted from the end, give the client address. 0 or false ignores the header.
   */
  trustProxy?: boolean | number;
  /** When set, GET /metrics needs the header `Authorization: Bearer <token>`. */
  metricsToken?: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();
const round1 = (n: number) => Math.round(n * 10) / 10;
const roundPoints = (points: Point[]): Point[] => points.map(([x, y]) => [round1(x), round1(y)]);

/** Constant-time check of an owner key against the stored hex hash. */
function ownerKeyMatches(key: string, storedHex: string): boolean {
  const stored = Buffer.from(storedHex, "hex");
  const given = sha256(key);
  return stored.length === given.length && timingSafeEqual(stored, given);
}

export function createWhiteboardServer(opts: WhiteboardServerOptions) {
  const { prisma, corsOrigin, metricsToken } = opts;
  const hops = trustHops(opts.trustProxy);
  const maxPerIp = opts.maxConnectionsPerIp ?? MAX_CONNECTIONS_PER_IP;

  const metrics = {
    connectionsCurrent: 0, connectionsTotal: 0, connectionsRejected: 0,
    joinsTotal: 0, commitsTotal: 0, rateLimitedTotal: 0, errorsTotal: 0,
  };
  const metricsText = () =>
    [
      ["whiteboard_connections_current", "gauge", metrics.connectionsCurrent],
      ["whiteboard_connections_total", "counter", metrics.connectionsTotal],
      ["whiteboard_connections_rejected_total", "counter", metrics.connectionsRejected],
      ["whiteboard_joins_total", "counter", metrics.joinsTotal],
      ["whiteboard_commits_total", "counter", metrics.commitsTotal],
      ["whiteboard_rate_limited_total", "counter", metrics.rateLimitedTotal],
      ["whiteboard_errors_total", "counter", metrics.errorsTotal],
    ].map(([name, type, value]) => `# TYPE ${name} ${type}\n${name} ${value}\n`).join("");

  const httpServer = createServer((req, res) => {
    let path = "";
    try { path = new URL(req.url ?? "/", "http://localhost").pathname; } catch { /* malformed target, 404 below */ }
    if (path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    if (path === "/metrics") {
      if (metricsToken) {
        const given = sha256(req.headers.authorization ?? "");
        if (!timingSafeEqual(given, sha256(`Bearer ${metricsToken}`))) {
          res.writeHead(401, { "www-authenticate": "Bearer" }).end();
          return;
        }
      }
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(metricsText());
      return;
    }
    res.writeHead(404).end();
  });

  const io: IoServer = new Server(httpServer, {
    cors: { origin: corsOrigin, methods: ["GET", "POST"] },
    maxHttpBufferSize: MAX_MESSAGE_BYTES,
    // A join sends the whole history; compression keeps that small.
    perMessageDeflate: { threshold: 1024 },
    // Browsers always send Origin; refuse any browser from another origin even on websocket,
    // where CORS itself does not apply. Non-browser clients send no Origin.
    allowRequest: (req, cb) => {
      const origin = req.headers.origin;
      cb(null, origin === undefined || origin === corsOrigin);
    },
  });

  /** boardId -> clientId -> user with the socket ids it currently has open. */
  const presence = new Map<string, Map<string, { name: string; proof: string | null; sockets: Set<string> }>>();
  const usersOf = (boardId: string): User[] =>
    [...(presence.get(boardId) ?? [])].map(([id, u]) => ({ id, name: u.name }));

  /**
   * Runs board writes one at a time within this process, so the order of relays always matches
   * the order of database writes. The advisory lock inside the commit transaction still guards
   * against other server processes.
   */
  const chains = new Map<string, Promise<unknown>>();
  function inBoardOrder<T>(boardId: string, fn: () => Promise<T>): Promise<T> {
    const run = (chains.get(boardId) ?? Promise.resolve()).then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    chains.set(boardId, tail);
    void tail.then(() => {
      if (chains.get(boardId) === tail) chains.delete(boardId);
    });
    return run;
  }

  const perIp = new Map<string, number>();
  const addressOf = (socket: IoSocket) => {
    const forwarded = socket.handshake.headers["x-forwarded-for"];
    return clientAddress(Array.isArray(forwarded) ? forwarded.join(",") : forwarded, hops, socket.handshake.address);
  };

  io.on("connection", (socket) => {
    const ip = addressOf(socket);
    const open = (perIp.get(ip) ?? 0) + 1;
    if (open > maxPerIp) {
      metrics.connectionsRejected++;
      socket.disconnect(true);
      return;
    }
    perIp.set(ip, open);
    metrics.connectionsCurrent++;
    metrics.connectionsTotal++;
    socket.on("disconnect", () => {
      metrics.connectionsCurrent--;
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left <= 0) perIp.delete(ip);
      else perIp.set(ip, left);
    });
    registerHandlers(socket);
  });

  function registerHandlers(socket: IoSocket) {
    /** Register an event whose first argument is untrusted and whose last argument may be an ack. */
    const buckets = createBuckets();
    const on = (
      event: keyof ClientToServerEvents,
      limit: LimitKind,
      handler: (raw: unknown, ack: Ackfn) => Promise<void> | void,
    ) => {
      (socket as Socket).on(event, async (...args: unknown[]) => {
        const last = args[args.length - 1];
        const ack = typeof last === "function" ? (last as (r: never) => void) : undefined;
        if (!buckets[limit].take()) {
          metrics.rateLimitedTotal++;
          ack?.({ ok: false, error: "rate_limited" } as never); // no-ack events are dropped silently
          return;
        }
        try {
          await handler(args[0] === ack ? undefined : args[0], ack);
        } catch (err) {
          metrics.errorsTotal++;
          console.error(`handler ${event} failed:`, err instanceof Error ? err.message : "unknown error");
          ack?.({ ok: false, error: "internal" } as never);
        }
      });
    };
    const fail = (ack: Ackfn, error: ErrorCode) => ack?.({ ok: false, error } as never);
    const done = (ack: Ackfn) => ack?.({ ok: true } as never);
    const ctx = () => {
      const { boardId, clientId, name, role, canClear, proof } = socket.data;
      return boardId && clientId && name && role
        ? { boardId, clientId, name, role, canClear: !!canClear, proof: proof ?? null, room: roomOf(boardId) }
        : null;
    };

    on("board:join", "join", async (raw, ack) => {
      const parsed = joinSchema.safeParse(raw);
      if (!parsed.success) return fail(ack, "invalid");
      if (socket.data.boardId || socket.data.joining) return fail(ack, "already_joined");
      socket.data.joining = true;
      const { boardId: editId, viewId, clientId, name, ownerKey, clientKey } = parsed.data;
      const proof = clientKey ? sha256(clientKey).toString("hex") : null;
      try {
        const board = await prisma.board.findUnique({
          where: editId ? { id: editId } : { id: undefined, viewId },
          select: { id: true, name: true, viewId: true, ownerHash: true },
        });
        if (!board) return fail(ack, "not_found");
        if (socket.disconnected) return;

        const role: Role = viewId
          ? "viewer"
          : ownerKey && board.ownerHash && ownerKeyMatches(ownerKey, board.ownerHash)
            ? "owner"
            : "editor";
        // Owned boards: only the owner clears. Boards from before owners existed keep the old rule.
        const canClear = role === "owner" || (role === "editor" && board.ownerHash === null);
        const boardId = board.id;
        const room = roomOf(boardId);

        // Join the room before reading history so no live event can fall between the two.
        await socket.join(room);
        let rows;
        try {
          rows = await prisma.stroke.findMany({ where: { boardId }, orderBy: { seq: "asc" } });
        } catch (err) {
          await socket.leave(room);
          throw err;
        }

        if (socket.disconnected) {
          // The client left while we were reading; do not register a user nobody will remove.
          await socket.leave(room);
          return;
        }
        // A client id is public (it is in every stroke), so it only counts as one person while the
        // same secret key is shown. A different key under a present id is somebody else. This check
        // sits right before presence is written, with no await in between, so two joins cannot slip past it.
        const present = presence.get(boardId)?.get(clientId);
        if (present && present.proof !== proof) {
          await socket.leave(room);
          return fail(ack, "forbidden");
        }
        socket.data.boardId = boardId;
        socket.data.clientId = clientId;
        socket.data.name = name;
        socket.data.proof = proof;
        socket.data.role = role;
        socket.data.canClear = canClear;
        metrics.joinsTotal++;

        const board_ = presence.get(boardId) ?? new Map();
        presence.set(boardId, board_);
        const existing = board_.get(clientId);
        if (existing) {
          existing.sockets.add(socket.id);
          existing.name = name;
        } else {
          board_.set(clientId, { name, proof, sockets: new Set([socket.id]) });
          socket.to(room).emit("user:joined", { id: clientId, name });
        }

        const strokes: Stroke[] = rows.map((r) => ({
          id: r.id, authorId: r.authorId, color: r.color, width: r.width,
          kind: r.kind as Stroke["kind"],
          points: r.points as Stroke["points"],
          ...(r.text ? { text: r.text } : {}),
        }));
        const reply: JoinAck = {
          ok: true, strokes, users: usersOf(boardId), role, canClear, boardName: board.name,
          ...(role === "viewer" ? {} : { viewId: board.viewId }),
        };
        ack?.(reply as never);
      } finally {
        socket.data.joining = false;
      }
    });

    on("stroke:progress", "progress", (raw) => {
      const c = ctx();
      if (!c || c.role === "viewer") return;
      const parsed = progressSchema.safeParse(raw);
      if (!parsed.success) return;
      socket.to(c.room).emit("stroke:progress", { ...parsed.data, points: roundPoints(parsed.data.points), authorId: c.clientId });
    });

    for (const event of ["cursor:move", "laser:move"] as const) {
      on(event, "cursor", (raw) => {
        const c = ctx(); // viewers may point, they just cannot change the board
        if (!c) return;
        const parsed = cursorSchema.safeParse(raw);
        if (!parsed.success) return;
        socket.to(c.room).volatile.emit(event, { id: c.clientId, name: c.name, ...parsed.data });
      });
    }

    on("stroke:commit", "commit", async (raw, ack) => {
      const c = ctx();
      if (!c) return fail(ack, "not_joined");
      if (c.role === "viewer") return fail(ack, "forbidden");
      const parsed = commitSchema.safeParse(raw);
      if (!parsed.success) return fail(ack, "invalid");
      const s = { ...parsed.data, points: roundPoints(parsed.data.points) };

      await inBoardOrder(c.boardId, async () => {
        const outcome = await prisma.$transaction(async (tx) => {
          // One writer per board at a time, so the cap check and the insert cannot interleave.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${c.boardId}, 0))`;
          const existing = await tx.stroke.findUnique({ where: { id: s.id }, select: { boardId: true, authorId: true, authorProof: true } });
          if (existing) {
            const sameAuthor = existing.boardId === c.boardId && existing.authorId === c.clientId &&
              (existing.authorProof === null || existing.authorProof === c.proof);
            return sameAuthor ? "duplicate" : "forbidden";
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
              id: s.id, boardId: c.boardId, authorId: c.clientId, authorProof: c.proof, color: s.color, width: s.width,
              kind: s.kind, text: s.text ?? null, points: s.points, pointCount: s.points.length,
            }],
            skipDuplicates: true,
          });
          // 0 rows means the id was taken by another board between the check and the insert.
          return res.count === 1 ? "created" : "forbidden";
        });

        if (outcome === "board_full") return fail(ack, "board_full");
        if (outcome === "forbidden") return fail(ack, "forbidden");
        if (outcome === "created") {
          metrics.commitsTotal++;
          socket.to(c.room).emit("stroke:commit", { ...s, authorId: c.clientId });
        }
        done(ack);
      });
    });

    on("stroke:undo", "undo", async (raw, ack) => {
      const c = ctx();
      if (!c) return fail(ack, "not_joined");
      if (c.role === "viewer") return fail(ack, "forbidden");
      const parsed = undoSchema.safeParse(raw);
      if (!parsed.success) return fail(ack, "invalid");
      await inBoardOrder(c.boardId, async () => {
        const res = await prisma.stroke.deleteMany({
          // Strokes made with a key can only be removed with the same key. Strokes made without one
          // (older boards, scripted clients) are matched by client id alone, as before.
          where: { id: parsed.data.id, boardId: c.boardId, authorId: c.clientId, OR: [{ authorProof: c.proof }, { authorProof: null }] },
        });
        if (res.count === 0) return fail(ack, "forbidden");
        socket.to(c.room).emit("stroke:remove", { id: parsed.data.id });
        done(ack);
      });
    });

    on("board:clear", "mutate", async (_raw, ack) => {
      const c = ctx();
      if (!c) return fail(ack, "not_joined");
      if (!c.canClear) return fail(ack, "forbidden");
      await inBoardOrder(c.boardId, async () => {
        await prisma.stroke.deleteMany({ where: { boardId: c.boardId } });
        socket.to(c.room).emit("board:cleared");
        done(ack);
      });
    });

    on("board:rename", "mutate", async (raw, ack) => {
      const c = ctx();
      if (!c) return fail(ack, "not_joined");
      if (c.role !== "owner") return fail(ack, "forbidden");
      const parsed = renameSchema.safeParse(raw);
      if (!parsed.success) return fail(ack, "invalid");
      await prisma.board.update({ where: { id: c.boardId }, data: { name: parsed.data.name } });
      socket.to(c.room).emit("board:renamed", { name: parsed.data.name });
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
