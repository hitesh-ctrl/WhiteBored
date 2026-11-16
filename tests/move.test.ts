import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoard, emitAck, joinAs, joinWith, record, sha256, sleep, startTestServer, stroke, uuid, waitFor, type TestServer } from "./helpers";

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

const mv = (ids: string[], dx: number, dy: number) => ({ moves: ids.map((id) => ({ id, newId: uuid() })), dx, dy });
const KEY = "move-key-move-key-0123456789ab";

async function setup() {
  const board = await createBoard(srv.prisma);
  const a = await joinAs(srv, board.id, "Ann");
  const b = await joinAs(srv, board.id, "Bob");
  return { board, a, b };
}

describe("moving own strokes", () => {
  it("replaces the stroke with a translated copy, tells the others, and keeps author, kind, colour and width", async () => {
    const { board, a, b } = await setup();
    const s = stroke({ points: [[100, 100], [200, 150]], color: "#aa5500", width: 7 });
    await emitAck(a.socket, "stroke:commit", s);
    const req = mv([s.id], 30, -20);
    const told = waitFor(b.socket, "stroke:moved");
    const ack = await emitAck(a.socket, "stroke:move", req);
    expect(ack.ok).toBe(true);
    expect(ack.strokes).toHaveLength(1);
    expect(ack.strokes[0]).toMatchObject({ id: req.moves[0].newId, authorId: a.clientId, kind: "pen", color: "#aa5500", width: 7, points: [[130, 80], [230, 130]] });
    expect(await told).toMatchObject({ removed: [s.id], added: [{ id: req.moves[0].newId, points: [[130, 80], [230, 130]] }] });
    expect(await srv.prisma.stroke.count({ where: { id: s.id } })).toBe(0);
    const row = await srv.prisma.stroke.findUniqueOrThrow({ where: { id: req.moves[0].newId } });
    expect(row).toMatchObject({ boardId: board.id, authorId: a.clientId, pointCount: 2 });
  });

  it("moves several strokes of different kinds together, text and fill included, and a late joiner sees only the new ones", async () => {
    const { board, a } = await setup();
    const rect = stroke({ kind: "rect", points: [[10, 10], [60, 60]] });
    const text = stroke({ kind: "text", text: "Hi", points: [[200, 200]] });
    const fill = stroke({ kind: "fill", width: 1, points: [[10, 10], [60, 10], [60, 60], [10, 60]] });
    for (const s of [rect, text, fill]) await emitAck(a.socket, "stroke:commit", s);
    const req = mv([rect.id, text.id, fill.id], 100, 50);
    const ack = await emitAck(a.socket, "stroke:move", req);
    expect(ack.ok).toBe(true);
    const late = await joinAs(srv, board.id, "Late");
    const byKind = Object.fromEntries(late.ack.strokes.map((x: any) => [x.kind, x]));
    expect(late.ack.strokes).toHaveLength(3);
    expect(byKind.rect.points).toEqual([[110, 60], [160, 110]]);
    expect(byKind.text).toMatchObject({ text: "Hi", points: [[300, 250]] });
    expect(byKind.fill.points).toEqual([[110, 60], [160, 60], [160, 110], [110, 110]]);
    expect(late.ack.strokes.map((x: any) => x.id).sort()).toEqual(req.moves.map((m) => m.newId).sort());
  });

  it("stops the whole group at the canvas edge so the shapes keep their relative positions", async () => {
    const { a } = await setup();
    const s1 = stroke({ kind: "line", points: [[100, 100], [200, 100]] }), s2 = stroke({ kind: "line", points: [[300, 100], [400, 100]] });
    await emitAck(a.socket, "stroke:commit", s1); await emitAck(a.socket, "stroke:commit", s2);
    const req = mv([s1.id, s2.id], -500, 0);
    const ack = await emitAck(a.socket, "stroke:move", req);
    expect(ack.strokes.map((x: any) => x.points)).toEqual([[[0, 100], [100, 100]], [[200, 100], [300, 100]]]);
  });

  it("rounds the shift to one decimal", async () => {
    const { a } = await setup();
    const s = stroke({ points: [[10, 10], [20, 20]] });
    await emitAck(a.socket, "stroke:commit", s);
    const ack = await emitAck(a.socket, "stroke:move", mv([s.id], 10.04999, 0.05001));
    expect(ack.strokes[0].points).toEqual([[20, 10.1], [30, 20.1]]);
  });

  it("keeps the board's point budget unchanged", async () => {
    const { board, a } = await setup();
    const s = stroke({ points: Array.from({ length: 40 }, (_, i) => [i, i]) });
    await emitAck(a.socket, "stroke:commit", s);
    const sum = async () => (await srv.prisma.stroke.aggregate({ where: { boardId: board.id }, _sum: { pointCount: true }, _count: true }));
    const before = await sum();
    await emitAck(a.socket, "stroke:move", mv([s.id], 10, 10));
    const after = await sum();
    expect([after._sum.pointCount, after._count]).toEqual([before._sum.pointCount, before._count]);
  });

  it("can move a stroke back under its original id (that is how undo of a move works)", async () => {
    const { a } = await setup();
    const s = stroke({ points: [[10, 10], [20, 20]] });
    await emitAck(a.socket, "stroke:commit", s);
    const first = mv([s.id], 100, 100);
    await emitAck(a.socket, "stroke:move", first);
    const back = await emitAck(a.socket, "stroke:move", { moves: [{ id: first.moves[0].newId, newId: s.id }], dx: -100, dy: -100 });
    expect(back.ok).toBe(true);
    expect(back.strokes[0]).toMatchObject({ id: s.id, points: [[10, 10], [20, 20]] });
  });
});

describe("moving is limited to your own strokes, atomically", () => {
  it("refuses someone else's stroke and changes nothing, even if the request also names your own", async () => {
    const { board, a, b } = await setup();
    const mine = stroke(), theirs = stroke();
    await emitAck(b.socket, "stroke:commit", mine);
    await emitAck(a.socket, "stroke:commit", theirs);
    const req = mv([mine.id, theirs.id], 20, 20);
    expect(await emitAck(b.socket, "stroke:move", req)).toEqual({ ok: false, error: "forbidden" });
    expect(await srv.prisma.stroke.count({ where: { id: { in: [mine.id, theirs.id] } } })).toBe(2);
    expect(await srv.prisma.stroke.count({ where: { id: { in: req.moves.map((m) => m.newId) } } })).toBe(0);
    expect(board.id).toBeTruthy();
  });

  it("refuses a stroke on another board and an id that does not exist", async () => {
    const { a } = await setup();
    const other = await createBoard(srv.prisma);
    const c = await joinAs(srv, other.id, "Cat", a.clientId);
    const s = stroke();
    await emitAck(c.socket, "stroke:commit", s);
    expect(await emitAck(a.socket, "stroke:move", mv([s.id], 5, 5))).toEqual({ ok: false, error: "forbidden" });
    expect(await emitAck(a.socket, "stroke:move", mv([uuid()], 5, 5))).toEqual({ ok: false, error: "forbidden" });
    expect(await srv.prisma.stroke.count({ where: { id: s.id } })).toBe(1);
  });

  it("refuses a view-only visitor, even one that shares the author's client id", async () => {
    const board = await createBoard(srv.prisma);
    const author = uuid();
    const a = await joinAs(srv, board.id, "Ann", author);
    const s = stroke();
    await emitAck(a.socket, "stroke:commit", s);
    const v = await joinWith(srv, { viewId: board.viewId, clientId: author, name: "Ann (view)" });
    expect(await emitAck(v.socket, "stroke:move", mv([s.id], 5, 5))).toEqual({ ok: false, error: "forbidden" });
    expect(await srv.prisma.stroke.count({ where: { id: s.id } })).toBe(1);
  });

  it("needs the same secret key as the stroke was made with, like undo", async () => {
    const board = await createBoard(srv.prisma);
    const id = uuid();
    const a = await joinWith(srv, { boardId: board.id, clientId: id, name: "Ann", clientKey: KEY });
    const s = stroke();
    await emitAck(a.socket, "stroke:commit", s);
    a.socket.close();
    await sleep(200);
    const m = await joinWith(srv, { boardId: board.id, clientId: id, name: "Mallory", clientKey: "x".repeat(32) });
    expect(await emitAck(m.socket, "stroke:move", mv([s.id], 5, 5))).toEqual({ ok: false, error: "forbidden" });
    expect(await srv.prisma.stroke.count({ where: { id: s.id } })).toBe(1);
  });

  it("a moved stroke keeps its author key: it stays protected from someone who only knows the client id", async () => {
    const board = await createBoard(srv.prisma);
    const id = uuid();
    const a = await joinWith(srv, { boardId: board.id, clientId: id, name: "Ann", clientKey: KEY });
    const s = stroke();
    await emitAck(a.socket, "stroke:commit", s);
    const req = mv([s.id], 40, 40);
    expect((await emitAck(a.socket, "stroke:move", req)).ok).toBe(true);
    const moved = req.moves[0].newId;
    expect((await srv.prisma.stroke.findUniqueOrThrow({ where: { id: moved } })).authorProof).toBe(sha256(KEY));
    a.socket.close();
    await sleep(200);
    const m = await joinWith(srv, { boardId: board.id, clientId: id, name: "Mallory", clientKey: "x".repeat(32) });
    expect(await emitAck(m.socket, "stroke:undo", { id: moved })).toEqual({ ok: false, error: "forbidden" });
    expect(await emitAck(m.socket, "stroke:move", mv([moved], 5, 5))).toEqual({ ok: false, error: "forbidden" });
    expect(await srv.prisma.stroke.count({ where: { id: moved } })).toBe(1);
  });

  it("refuses a new id that already belongs to somebody else's stroke", async () => {
    const { a, b } = await setup();
    const mine = stroke(), theirs = stroke();
    await emitAck(a.socket, "stroke:commit", mine);
    await emitAck(b.socket, "stroke:commit", theirs);
    expect(await emitAck(a.socket, "stroke:move", { moves: [{ id: mine.id, newId: theirs.id }], dx: 5, dy: 5 })).toEqual({ ok: false, error: "forbidden" });
    expect(await srv.prisma.stroke.count({ where: { id: { in: [mine.id, theirs.id] } } })).toBe(2);
  });
});

describe("retries and validation", () => {
  it("a repeated request does not move again and is not relayed twice", async () => {
    const { a, b } = await setup();
    const s = stroke({ points: [[10, 10], [20, 20]] });
    await emitAck(a.socket, "stroke:commit", s);
    const req = mv([s.id], 50, 50);
    const got = record(b.socket, ["stroke:moved"]);
    const first = await emitAck(a.socket, "stroke:move", req);
    const second = await emitAck(a.socket, "stroke:move", req);
    expect(second.ok).toBe(true);
    expect(second.strokes[0].points).toEqual(first.strokes[0].points);
    expect(second.strokes[0].points).toEqual([[60, 60], [70, 70]]);
    await sleep(300);
    expect(got).toHaveLength(1);
    expect(await srv.prisma.stroke.count({ where: { id: req.moves[0].newId } })).toBe(1);
  });

  const bad: [string, unknown][] = [
    ["no moves", { moves: [], dx: 1, dy: 1 }],
    ["too many moves", { moves: Array.from({ length: 101 }, () => ({ id: uuid(), newId: uuid() })), dx: 1, dy: 1 }],
    ["duplicate ids", (() => { const id = uuid(); return { moves: [{ id, newId: uuid() }, { id, newId: uuid() }], dx: 1, dy: 1 }; })()],
    ["duplicate new ids", (() => { const n = uuid(); return { moves: [{ id: uuid(), newId: n }, { id: uuid(), newId: n }], dx: 1, dy: 1 }; })()],
    ["new id equal to the old id", (() => { const id = uuid(); return { moves: [{ id, newId: id }], dx: 1, dy: 1 }; })()],
    ["a new id that is also an old id", (() => { const a = uuid(), b = uuid(); return { moves: [{ id: a, newId: b }, { id: b, newId: uuid() }], dx: 1, dy: 1 }; })()],
    ["bad id", { moves: [{ id: "x", newId: uuid() }], dx: 1, dy: 1 }],
    ["dx not a number", { moves: [{ id: uuid(), newId: uuid() }], dx: "1", dy: 1 }],
    ["dx too large", { moves: [{ id: uuid(), newId: uuid() }], dx: 1e9, dy: 1 }],
    ["dy missing", { moves: [{ id: uuid(), newId: uuid() }], dx: 1 }],
    ["no payload", undefined],
  ];
  it.each(bad)("rejects %s", async (_n, payload) => {
    const { a } = await setup();
    expect(await emitAck(a.socket, "stroke:move", payload)).toEqual({ ok: false, error: "invalid" });
  });

  it("rejects a move before joining", async () => {
    const s = await srv.connect();
    expect(await emitAck(s, "stroke:move", mv([uuid()], 1, 1))).toEqual({ ok: false, error: "not_joined" });
  });
});

describe("fills stay bound to their shape when it moves", () => {
  const fillOf = (containerId: string, over: Record<string, unknown> = {}) =>
    stroke({ kind: "fill", width: 1, color: "#ffcc00", containerId, points: [[100, 100], [300, 100], [300, 200], [100, 200]], ...over });

  it("moving a shape together with its fill points the moved fill at the moved shape", async () => {
    const { a, b } = await setup();
    const rect = stroke({ kind: "rect", points: [[100, 100], [300, 200]] });
    const fill = fillOf(rect.id);
    await emitAck(a.socket, "stroke:commit", rect);
    await emitAck(a.socket, "stroke:commit", fill);
    await sleep(200);
    const req = mv([rect.id, fill.id], 50, 25);
    const told = waitFor(b.socket, "stroke:moved");
    const ack = await emitAck(a.socket, "stroke:move", req);
    expect(ack.ok).toBe(true);
    const [newRect, newFill] = ack.strokes;
    expect(newFill).toMatchObject({ kind: "fill", containerId: newRect.id, points: [[150, 125], [350, 125], [350, 225], [150, 225]] });
    expect(newRect.id).toBe(req.moves[0].newId);
    expect((await told).added.find((x: any) => x.kind === "fill").containerId).toBe(newRect.id);
    expect((await srv.prisma.stroke.findUniqueOrThrow({ where: { id: newFill.id } })).containerId).toBe(newRect.id);
  });

  it("moving a fill without its shape unbinds it", async () => {
    const { a } = await setup();
    const rect = stroke({ kind: "rect", points: [[100, 100], [300, 200]] });
    const fill = fillOf(rect.id);
    await emitAck(a.socket, "stroke:commit", rect);
    await emitAck(a.socket, "stroke:commit", fill);
    const ack = await emitAck(a.socket, "stroke:move", mv([fill.id], 10, 10));
    expect(ack.ok).toBe(true);
    expect(ack.strokes[0].containerId).toBeUndefined();
    expect((await srv.prisma.stroke.findUniqueOrThrow({ where: { id: ack.strokes[0].id } })).containerId).toBeNull();
  });

  it("moving them back (undo of a move) points the fill at the original shape id again", async () => {
    const { a } = await setup();
    const rect = stroke({ kind: "rect", points: [[100, 100], [300, 200]] });
    const fill = fillOf(rect.id);
    await emitAck(a.socket, "stroke:commit", rect);
    await emitAck(a.socket, "stroke:commit", fill);
    const first = mv([rect.id, fill.id], 80, 40);
    await emitAck(a.socket, "stroke:move", first);
    const back = await emitAck(a.socket, "stroke:move", {
      moves: first.moves.map((m, i) => ({ id: m.newId, newId: [rect.id, fill.id][i] })), dx: -80, dy: -40,
    });
    expect(back.ok).toBe(true);
    expect(back.strokes[1]).toMatchObject({ id: fill.id, containerId: rect.id, points: fill.points });
  });

  it("a fill that points at a shape outside the request is unbound when moved with other strokes", async () => {
    const { a } = await setup();
    const rect = stroke({ kind: "rect", points: [[100, 100], [300, 200]] }), other = stroke();
    const fill = fillOf(rect.id);
    for (const s of [rect, fill, other]) await emitAck(a.socket, "stroke:commit", s);
    const ack = await emitAck(a.socket, "stroke:move", mv([fill.id, other.id], 5, 5));
    expect(ack.strokes[0].containerId).toBeUndefined();
  });
});
