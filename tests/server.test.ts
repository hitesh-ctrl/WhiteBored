import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_POINTS_PER_BATCH,
  MAX_POINTS_PER_BOARD,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES_PER_BOARD,
} from "../src/shared/limits";
import {
  createBoard, emitAck, joinAs, record, sleep, startTestServer, stroke, uuid, waitFor,
  type TestServer,
} from "./helpers";

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

const pts = (n: number) => Array.from({ length: n }, (_, i) => [i % 1600, i % 900]);

describe("join", () => {
  it("returns history ordered by seq and the current users in the ack", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const s1 = stroke(), s2 = stroke(), s3 = stroke();
    for (const s of [s1, s2, s3]) expect(await emitAck(a.socket, "stroke:commit", s)).toEqual({ ok: true });

    const b = await joinAs(srv, board.id, "Bob");
    expect(b.ack.ok).toBe(true);
    expect(b.ack.strokes.map((s: any) => s.id)).toEqual([s1.id, s2.id, s3.id]);
    expect(b.ack.strokes[0]).toMatchObject({ authorId: a.clientId, color: "#112233", width: 4 });
    expect(b.ack.users).toEqual(expect.arrayContaining([{ id: a.clientId, name: "Ann" }]));
  });

  it("rejects an unknown board", async () => {
    const s = await srv.connect();
    const ack = await emitAck(s, "board:join", { boardId: uuid(), clientId: uuid(), name: "X" });
    expect(ack).toEqual({ ok: false, error: "not_found" });
  });

  it.each([
    ["bad board id", { boardId: "nope", clientId: uuid(), name: "X" }],
    ["bad client id", { boardId: uuid(), clientId: "nope", name: "X" }],
    ["empty name", { boardId: uuid(), clientId: uuid(), name: "" }],
    ["long name", { boardId: uuid(), clientId: uuid(), name: "x".repeat(31) }],
    ["no payload", undefined],
  ])("rejects an invalid join: %s", async (_n, payload) => {
    const s = await srv.connect();
    const ack = await emitAck(s, "board:join", payload);
    expect(ack).toEqual({ ok: false, error: "invalid" });
  });

  it("treats SQL-looking names as plain text", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "'; DROP TABLE \"Stroke\";--");
    expect(a.ack.ok).toBe(true);
    expect(await srv.prisma.board.count({ where: { id: board.id } })).toBe(1);
  });

  it("allows only one board per connection", async () => {
    const b1 = await createBoard(srv.prisma), b2 = await createBoard(srv.prisma);
    const a = await joinAs(srv, b1.id, "Ann");
    const again = await emitAck(a.socket, "board:join", { boardId: b2.id, clientId: a.clientId, name: "Ann" });
    expect(again).toEqual({ ok: false, error: "already_joined" });
  });

  it("announces joins and leaves to the others", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const joined = waitFor(a.socket, "user:joined");
    const b = await joinAs(srv, board.id, "Bob");
    expect(await joined).toEqual({ id: b.clientId, name: "Bob" });
    const left = waitFor(a.socket, "user:left");
    b.socket.close();
    expect(await left).toEqual({ id: b.clientId });
  });
});

describe("before join", () => {
  it("rejects commit, undo and clear with not_joined", async () => {
    const s = await srv.connect();
    expect(await emitAck(s, "stroke:commit", stroke())).toEqual({ ok: false, error: "not_joined" });
    expect(await emitAck(s, "stroke:undo", { id: uuid() })).toEqual({ ok: false, error: "not_joined" });
    expect(await emitAck(s, "board:clear")).toEqual({ ok: false, error: "not_joined" });
  });

  it("does not relay progress or cursors from a socket that never joined", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const got = record(a.socket, ["stroke:progress", "cursor:move"]);
    const s = await srv.connect();
    s.emit("stroke:progress", stroke());
    s.emit("cursor:move", { x: 1, y: 1 });
    await sleep(300);
    expect(got).toEqual([]);
  });
});

describe("live relay", () => {
  it("relays progress and commit to others but never back to the sender", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const b = await joinAs(srv, board.id, "Bob");
    const echoes = record(a.socket, ["stroke:progress", "stroke:commit", "stroke:remove", "board:cleared", "cursor:move"]);

    const s = stroke();
    const prog = waitFor(b.socket, "stroke:progress");
    a.socket.emit("stroke:progress", s);
    expect(await prog).toMatchObject({ id: s.id, authorId: a.clientId, color: s.color });

    const commit = waitFor(b.socket, "stroke:commit");
    await emitAck(a.socket, "stroke:commit", s);
    expect(await commit).toMatchObject({ id: s.id, authorId: a.clientId, points: s.points });

    const cur = waitFor(b.socket, "cursor:move");
    a.socket.volatile.emit("cursor:move", { x: 5, y: 6 });
    expect(await cur).toEqual({ id: a.clientId, name: "Ann", x: 5, y: 6 });

    await emitAck(a.socket, "stroke:undo", { id: s.id });
    await sleep(300);
    expect(echoes).toEqual([]);
  });

  it("keeps boards isolated", async () => {
    const b1 = await createBoard(srv.prisma), b2 = await createBoard(srv.prisma);
    const a = await joinAs(srv, b1.id, "Ann");
    const other = await joinAs(srv, b2.id, "Zed");
    const got = record(other.socket, ["stroke:progress", "stroke:commit", "stroke:remove", "board:cleared", "cursor:move", "user:joined"]);
    const s = stroke();
    a.socket.emit("stroke:progress", s);
    a.socket.emit("cursor:move", { x: 1, y: 1 });
    await emitAck(a.socket, "stroke:commit", s);
    await emitAck(a.socket, "stroke:undo", { id: s.id });
    await emitAck(a.socket, "board:clear");
    await sleep(300);
    expect(got).toEqual([]);
  });

  it("ignores identity fields smuggled into messages", async () => {
    const board = await createBoard(srv.prisma), other = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const b = await joinAs(srv, board.id, "Bob");
    const commit = waitFor(b.socket, "stroke:commit");
    const s = { ...stroke(), authorId: uuid(), boardId: other.id, name: "Evil" };
    await emitAck(a.socket, "stroke:commit", s);
    const got = await commit;
    expect(got.authorId).toBe(a.clientId);
    const row = await srv.prisma.stroke.findUnique({ where: { id: s.id } });
    expect(row?.boardId).toBe(board.id);
    expect(row?.authorId).toBe(a.clientId);
  });
});

describe("commit", () => {
  it("is idempotent: the same stroke sent twice is stored once", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const s = stroke();
    expect(await emitAck(a.socket, "stroke:commit", s)).toEqual({ ok: true });
    expect(await emitAck(a.socket, "stroke:commit", s)).toEqual({ ok: true });
    expect(await srv.prisma.stroke.count({ where: { boardId: board.id } })).toBe(1);
  });

  it("does not relay a retried commit a second time", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const b = await joinAs(srv, board.id, "Bob");
    const got = record(b.socket, ["stroke:commit"]);
    const s = stroke();
    await emitAck(a.socket, "stroke:commit", s);
    await emitAck(a.socket, "stroke:commit", s);
    await sleep(300);
    expect(got).toHaveLength(1);
  });

  it("refuses a stroke id already used by someone else", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const b = await joinAs(srv, board.id, "Bob");
    const s = stroke();
    await emitAck(a.socket, "stroke:commit", s);
    const got = record(a.socket, ["stroke:commit"]);
    expect(await emitAck(b.socket, "stroke:commit", s)).toEqual({ ok: false, error: "forbidden" });
    await sleep(200);
    expect(got).toEqual([]);
    const row = await srv.prisma.stroke.findUnique({ where: { id: s.id } });
    expect(row?.authorId).toBe(a.clientId);
  });

  it("a stroke id raced from two boards is stored once and never causes an internal error", async () => {
    for (let round = 0; round < 15; round++) {
      const b1 = await createBoard(srv.prisma), b2 = await createBoard(srv.prisma);
      const a = await joinAs(srv, b1.id, "Ann"), b = await joinAs(srv, b2.id, "Bob");
      const s = stroke();
      const acks = await Promise.all([emitAck(a.socket, "stroke:commit", s), emitAck(b.socket, "stroke:commit", s)]);
      expect(acks.filter((x) => x.ok)).toHaveLength(1);
      expect(acks.filter((x) => !x.ok && x.error === "forbidden")).toHaveLength(1);
      expect(await srv.prisma.stroke.count({ where: { id: s.id } })).toBe(1);
    }
  });

  it("stores the points as sent and counts them", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const s = stroke({ points: pts(50) });
    await emitAck(a.socket, "stroke:commit", s);
    const row = await srv.prisma.stroke.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.points).toEqual(s.points);
    expect(row.pointCount).toBe(50);
  });

  const bad: [string, Record<string, unknown>][] = [
    ["colour without #", { color: "112233" }],
    ["named colour", { color: "red" }],
    ["short colour", { color: "#123" }],
    ["width 0", { width: 0 }],
    ["width 41", { width: 41 }],
    ["fractional width", { width: 2.5 }],
    ["id not a uuid", { id: "abc" }],
    ["no points", { points: [] }],
    ["x out of range", { points: [[1601, 5]] }],
    ["y out of range", { points: [[5, 901]] }],
    ["negative x", { points: [[-1, 5]] }],
    ["NaN-like string point", { points: [["a", 5]] }],
    ["point with three values", { points: [[1, 2, 3]] }],
    ["too many points", { points: pts(MAX_POINTS_PER_STROKE + 1) }],
  ];
  it.each(bad)("rejects %s", async (_n, over) => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const s = stroke(over);
    expect(await emitAck(a.socket, "stroke:commit", s)).toEqual({ ok: false, error: "invalid" });
    expect(await srv.prisma.stroke.count({ where: { boardId: board.id } })).toBe(0);
  });

  it("accepts the maximum allowed stroke", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    expect(await emitAck(a.socket, "stroke:commit", stroke({ points: pts(MAX_POINTS_PER_STROKE), width: 40 }))).toEqual({ ok: true });
  });

  it("does not relay invalid progress batches", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const b = await joinAs(srv, board.id, "Bob");
    const got = record(b.socket, ["stroke:progress"]);
    a.socket.emit("stroke:progress", stroke({ points: pts(MAX_POINTS_PER_BATCH + 1) }));
    a.socket.emit("stroke:progress", stroke({ color: "nope" }));
    a.socket.emit("stroke:progress", stroke({ points: [] }));
    a.socket.emit("stroke:progress", "garbage");
    await sleep(300);
    expect(got).toEqual([]);
    const ok = waitFor(b.socket, "stroke:progress");
    a.socket.emit("stroke:progress", stroke({ points: pts(MAX_POINTS_PER_BATCH) }));
    expect((await ok).points).toHaveLength(MAX_POINTS_PER_BATCH);
  });

  it("does not relay invalid cursor positions", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const b = await joinAs(srv, board.id, "Bob");
    const got = record(b.socket, ["cursor:move"]);
    a.socket.emit("cursor:move", { x: 99999, y: 1 });
    a.socket.emit("cursor:move", { x: "1", y: 1 });
    await sleep(300);
    expect(got).toEqual([]);
  });
});

describe("board limits", () => {
  it(`rejects strokes past ${MAX_STROKES_PER_BOARD} per board`, async () => {
    const board = await createBoard(srv.prisma);
    await srv.prisma.stroke.createMany({
      data: Array.from({ length: MAX_STROKES_PER_BOARD }, () => ({
        id: uuid(), boardId: board.id, authorId: uuid(), color: "#000000", width: 1, points: [[1, 1]], pointCount: 1,
      })),
    });
    const a = await joinAs(srv, board.id, "Ann");
    const s = stroke();
    expect(await emitAck(a.socket, "stroke:commit", s)).toEqual({ ok: false, error: "board_full" });
    expect(await srv.prisma.stroke.findUnique({ where: { id: s.id } })).toBeNull();
  });

  it("rejects strokes past the per-board point budget", async () => {
    const board = await createBoard(srv.prisma);
    await srv.prisma.stroke.create({
      data: { id: uuid(), boardId: board.id, authorId: uuid(), color: "#000000", width: 1, points: [[1, 1]], pointCount: MAX_POINTS_PER_BOARD - 1 },
    });
    const a = await joinAs(srv, board.id, "Ann");
    expect(await emitAck(a.socket, "stroke:commit", stroke())).toEqual({ ok: false, error: "board_full" });
  });

  it("still accepts a retry of an existing stroke on a full board", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const s = stroke();
    await emitAck(a.socket, "stroke:commit", s);
    await srv.prisma.stroke.create({
      data: { id: uuid(), boardId: board.id, authorId: uuid(), color: "#000000", width: 1, points: [[1, 1]], pointCount: MAX_POINTS_PER_BOARD - 100 },
    });
    expect(await emitAck(a.socket, "stroke:commit", s)).toEqual({ ok: true });
  });

  it("concurrent commits cannot overshoot the stroke cap", async () => {
    const board = await createBoard(srv.prisma);
    await srv.prisma.stroke.createMany({
      data: Array.from({ length: MAX_STROKES_PER_BOARD - 3 }, () => ({
        id: uuid(), boardId: board.id, authorId: uuid(), color: "#000000", width: 1, points: [[1, 1]], pointCount: 1,
      })),
    });
    const clients = await Promise.all(Array.from({ length: 8 }, (_, i) => joinAs(srv, board.id, `C${i}`)));
    const acks = await Promise.all(clients.map((c) => emitAck(c.socket, "stroke:commit", stroke())));
    expect(acks.filter((a) => a.ok)).toHaveLength(3);
    expect(await srv.prisma.stroke.count({ where: { boardId: board.id } })).toBe(MAX_STROKES_PER_BOARD);
  });
});

describe("undo", () => {
  it("removes the author's own stroke and tells the others", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const b = await joinAs(srv, board.id, "Bob");
    const s = stroke();
    await emitAck(a.socket, "stroke:commit", s);
    const removed = waitFor(b.socket, "stroke:remove");
    expect(await emitAck(a.socket, "stroke:undo", { id: s.id })).toEqual({ ok: true });
    expect(await removed).toEqual({ id: s.id });
    expect(await srv.prisma.stroke.findUnique({ where: { id: s.id } })).toBeNull();
  });

  it("refuses to undo someone else's stroke", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const b = await joinAs(srv, board.id, "Bob");
    const s = stroke();
    await emitAck(a.socket, "stroke:commit", s);
    const got = record(a.socket, ["stroke:remove"]);
    expect(await emitAck(b.socket, "stroke:undo", { id: s.id })).toEqual({ ok: false, error: "forbidden" });
    await sleep(200);
    expect(got).toEqual([]);
    expect(await srv.prisma.stroke.findUnique({ where: { id: s.id } })).not.toBeNull();
  });

  it("refuses to undo a stroke that lives on another board, even by the same author", async () => {
    const b1 = await createBoard(srv.prisma), b2 = await createBoard(srv.prisma);
    const author = uuid();
    const a1 = await joinAs(srv, b1.id, "Ann", author);
    const a2 = await joinAs(srv, b2.id, "Ann", author);
    const s = stroke();
    await emitAck(a1.socket, "stroke:commit", s);
    expect(await emitAck(a2.socket, "stroke:undo", { id: s.id })).toEqual({ ok: false, error: "forbidden" });
    expect(await srv.prisma.stroke.findUnique({ where: { id: s.id } })).not.toBeNull();
  });

  it("rejects a malformed undo", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    expect(await emitAck(a.socket, "stroke:undo", { id: "x" })).toEqual({ ok: false, error: "invalid" });
    expect(await emitAck(a.socket, "stroke:undo", { id: uuid() })).toEqual({ ok: false, error: "forbidden" });
  });
});

describe("clear", () => {
  it("deletes only this board's strokes and tells the others", async () => {
    const b1 = await createBoard(srv.prisma), b2 = await createBoard(srv.prisma);
    const a = await joinAs(srv, b1.id, "Ann");
    const b = await joinAs(srv, b1.id, "Bob");
    const z = await joinAs(srv, b2.id, "Zed");
    await emitAck(a.socket, "stroke:commit", stroke());
    await emitAck(b.socket, "stroke:commit", stroke());
    await emitAck(z.socket, "stroke:commit", stroke());
    const cleared = waitFor(b.socket, "board:cleared");
    expect(await emitAck(a.socket, "board:clear")).toEqual({ ok: true });
    await cleared;
    expect(await srv.prisma.stroke.count({ where: { boardId: b1.id } })).toBe(0);
    expect(await srv.prisma.stroke.count({ where: { boardId: b2.id } })).toBe(1);
  });
});

describe("late joiners and reconnects", () => {
  it("a late joiner sees everything drawn before, without the cleared and undone strokes", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const keep = stroke(), gone = stroke();
    await emitAck(a.socket, "stroke:commit", gone);
    await emitAck(a.socket, "board:clear");
    await emitAck(a.socket, "stroke:commit", keep);
    await emitAck(a.socket, "stroke:commit", gone);
    await emitAck(a.socket, "stroke:undo", { id: gone.id });
    const late = await joinAs(srv, board.id, "Late");
    expect(late.ack.strokes.map((s: any) => s.id)).toEqual([keep.id]);
  });

  it("re-joining after a reconnect returns history that includes what was missed", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const b = await joinAs(srv, board.id, "Bob");
    const left = waitFor(a.socket, "user:left");
    b.socket.disconnect();
    await left;
    const missed = stroke();
    await emitAck(a.socket, "stroke:commit", missed);

    b.socket.connect();
    await waitFor(b.socket, "connect");
    const ack = await emitAck(b.socket, "board:join", { boardId: board.id, clientId: b.clientId, name: "Bob" });
    expect(ack.ok).toBe(true);
    expect(ack.strokes.map((s: any) => s.id)).toEqual([missed.id]);
    expect(ack.users.map((u: any) => u.name).sort()).toEqual(["Ann", "Bob"]);
  });

  it("keeps a user listed while a second socket with the same client id is still open", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const id = uuid();
    const b1 = await joinAs(srv, board.id, "Bob", id);
    const b2 = await joinAs(srv, board.id, "Bob", id);
    const got = record(a.socket, ["user:left"]);
    b1.socket.close();
    await sleep(300);
    expect(got).toEqual([]);
    b2.socket.close();
    await sleep(300);
    expect(got).toEqual([{ event: "user:left", data: { id } }]);
  });
});
