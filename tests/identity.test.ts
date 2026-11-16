import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoard, emitAck, joinAs, joinWith, record, sha256, sleep, startTestServer, stroke, uuid, waitFor, type TestServer } from "./helpers";

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

const K1 = "key-one-key-one-key-one-0123456789";
const K2 = "key-two-key-two-key-two-0123456789";
const keyed = (boardId: string, clientId: string, clientKey?: string, name = "X") => joinWith(srv, { boardId, clientId, name, ...(clientKey ? { clientKey } : {}) });

describe("author identity is bound to a secret, not only to the public client id", () => {
  it("someone who knows a client id but not its key cannot undo its strokes", async () => {
    const board = await createBoard(srv.prisma);
    const id = uuid();
    const a = await keyed(board.id, id, K1, "Ann");
    const s = stroke();
    expect(await emitAck(a.socket, "stroke:commit", s)).toEqual({ ok: true });
    a.socket.close();
    await sleep(200);
    const wrong = await keyed(board.id, id, K2, "Mallory");
    expect(wrong.ack.ok).toBe(true); // nobody is present under this id any more
    expect(await emitAck(wrong.socket, "stroke:undo", { id: s.id })).toEqual({ ok: false, error: "forbidden" });
    wrong.socket.close(); // one identity at a time: a present id refuses a different key
    await sleep(200);
    const none = await keyed(board.id, id, undefined, "Mallory2");
    expect(await emitAck(none.socket, "stroke:undo", { id: s.id })).toEqual({ ok: false, error: "forbidden" });
    expect(await srv.prisma.stroke.count({ where: { id: s.id } })).toBe(1);
    none.socket.close();
    await sleep(200);
    const back = await keyed(board.id, id, K1, "Ann");
    expect(await emitAck(back.socket, "stroke:undo", { id: s.id })).toEqual({ ok: true });
  });

  it("stores only a hash of the key, and never sends the key, the hash or the proof to anyone", async () => {
    const board = await createBoard(srv.prisma);
    const id = uuid();
    const a = await keyed(board.id, id, K1, "Ann");
    const s = stroke();
    await emitAck(a.socket, "stroke:commit", s);
    const row = await srv.prisma.stroke.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.authorProof).toBe(sha256(K1));
    expect(row.authorProof).not.toBe(K1);
    const late = await keyed(board.id, uuid(), K2, "Late");
    const text = JSON.stringify(late.ack);
    for (const secret of [K1, sha256(K1), "authorProof"]) expect(text).not.toContain(secret);
  });

  it("a join under a client id that is already present with a different key is refused", async () => {
    const board = await createBoard(srv.prisma);
    const id = uuid();
    await keyed(board.id, id, K1, "Ann");
    expect((await keyed(board.id, id, K2, "Mallory")).ack).toEqual({ ok: false, error: "forbidden" });
    expect((await keyed(board.id, id, undefined, "Mallory")).ack).toEqual({ ok: false, error: "forbidden" });
    expect((await keyed(board.id, id, K1, "Ann second tab")).ack.ok).toBe(true);
  });

  it("the refused join does not rename or announce anyone", async () => {
    const board = await createBoard(srv.prisma);
    const id = uuid();
    const a = await keyed(board.id, id, K1, "Ann");
    const watcher = await joinAs(srv, board.id, "Watcher");
    const got = record(watcher.socket, ["user:joined", "user:left"]);
    await keyed(board.id, id, K2, "Impostor");
    await sleep(300);
    expect(got).toEqual([]);
    const late = await joinAs(srv, board.id, "Late");
    expect(late.ack.users.find((u: any) => u.id === id)?.name).toBe("Ann");
    expect(a.ack.ok).toBe(true);
  });

  it("a retried commit by the same keyed author is accepted, by another key it is refused", async () => {
    const board = await createBoard(srv.prisma);
    const id = uuid();
    const a = await keyed(board.id, id, K1, "Ann");
    const s = stroke();
    await emitAck(a.socket, "stroke:commit", s);
    expect(await emitAck(a.socket, "stroke:commit", s)).toEqual({ ok: true });
    a.socket.close();
    await sleep(200);
    const m = await keyed(board.id, id, K2, "Mallory");
    expect(await emitAck(m.socket, "stroke:commit", s)).toEqual({ ok: false, error: "forbidden" });
  });

  it("strokes made without a key keep working without one", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const s = stroke();
    await emitAck(a.socket, "stroke:commit", s);
    expect(await emitAck(a.socket, "stroke:undo", { id: s.id })).toEqual({ ok: true });
  });

  it("rejects a key that is too short or the wrong type", async () => {
    const board = await createBoard(srv.prisma);
    for (const k of ["short", 5, ["x".repeat(20)], "x".repeat(129)]) {
      expect((await joinWith(srv, { boardId: board.id, clientId: uuid(), name: "X", clientKey: k })).ack).toEqual({ ok: false, error: "invalid" });
    }
  });
});

describe("points are rounded to one decimal on the server", () => {
  it("stores and relays rounded commit points, and relays rounded progress points", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const b = await joinAs(srv, board.id, "Bob");
    const prog = waitFor(b.socket, "stroke:progress");
    a.socket.emit("stroke:progress", stroke({ points: [[1.23456789012345, 2.99999999999]] }));
    expect((await prog).points).toEqual([[1.2, 3]]);
    const relayed = waitFor(b.socket, "stroke:commit");
    const s = stroke({ points: [[10.04999, 20.05001], [1599.97, 0.04]] });
    await emitAck(a.socket, "stroke:commit", s);
    expect((await relayed).points).toEqual([[10, 20.1], [1600, 0]]);
    const row = await srv.prisma.stroke.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.points).toEqual([[10, 20.1], [1600, 0]]);
  });
});

describe("text and name characters", () => {
  const board = () => createBoard(srv.prisma);
  it.each([
    ["right-to-left override", "a‮b"],
    ["left-to-right isolate", "a⁦b"],
    ["non-character U+FFFE", "a￾b"],
    ["non-character U+FFFF", "a￿b"],
    ["lone surrogate", "a\uD800b"],
  ])("rejects %s in text and in names", async (_n, bad) => {
    const b = await board();
    const a = await joinAs(srv, b.id, "Ann");
    expect(await emitAck(a.socket, "stroke:commit", stroke({ kind: "text", text: bad, points: [[1, 1]] }))).toEqual({ ok: false, error: "invalid" });
    const j = await joinWith(srv, { boardId: b.id, clientId: uuid(), name: bad });
    expect(j.ack).toEqual({ ok: false, error: "invalid" });
  });
  it("accepts emoji joined with zero-width joiners and accented letters", async () => {
    const b = await board();
    const a = await joinAs(srv, b.id, "Zoë 👨‍👩‍👧");
    expect(a.ack.ok).toBe(true);
    expect(await emitAck(a.socket, "stroke:commit", stroke({ kind: "text", text: "Grüße 👨‍👩‍👧", points: [[1, 1]] }))).toEqual({ ok: true });
  });
});

describe("undo has its own, higher limit (the eraser sends many)", () => {
  it("30 quick undos of own strokes all succeed", async () => {
    const b = await createBoard(srv.prisma);
    const a = await joinAs(srv, b.id, "Ann");
    const ids = Array.from({ length: 30 }, () => uuid());
    await srv.prisma.stroke.createMany({ data: ids.map((id) => ({ id, boardId: b.id, authorId: a.clientId, color: "#000000", width: 1, points: [[1, 1]], pointCount: 1 })) });
    const acks = await Promise.all(ids.map((id) => emitAck(a.socket, "stroke:undo", { id })));
    expect(acks.filter((x) => x.ok)).toHaveLength(30);
  });
  it("clear and rename keep the stricter limit", async () => {
    const b = await createBoard(srv.prisma);
    const a = await joinAs(srv, b.id, "Ann");
    const acks = await Promise.all(Array.from({ length: 30 }, () => emitAck(a.socket, "board:clear")));
    expect(acks.some((x) => x.error === "rate_limited")).toBe(true);
  });
});
