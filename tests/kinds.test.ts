import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoard, emitAck, joinAs, record, sleep, startTestServer, stroke, uuid, waitFor, type TestServer } from "./helpers";

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

const shape = (kind: string, over: Record<string, unknown> = {}) => stroke({ kind, points: [[100, 100], [300, 200]], ...over });
const textStroke = (over: Record<string, unknown> = {}) => stroke({ kind: "text", text: "Hello", points: [[50, 60]], ...over });

describe("stroke kinds", () => {
  it.each(["line", "arrow", "rect", "ellipse"])("accepts, stores, relays and replays a %s", async (kind) => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const b = await joinAs(srv, board.id, "Bob");
    const s = shape(kind);
    const relayed = waitFor(b.socket, "stroke:commit");
    expect(await emitAck(a.socket, "stroke:commit", s)).toEqual({ ok: true });
    expect(await relayed).toMatchObject({ id: s.id, kind, points: s.points, authorId: a.clientId });
    const row = await srv.prisma.stroke.findUniqueOrThrow({ where: { id: s.id } });
    expect(row).toMatchObject({ kind, text: null, pointCount: 2 });
    const late = await joinAs(srv, board.id, "Late");
    expect(late.ack.strokes.find((x: any) => x.id === s.id)).toMatchObject({ kind, points: s.points });
  });

  it("accepts text with its content and replays it", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const b = await joinAs(srv, board.id, "Bob");
    const t = textStroke({ text: "Hello <b>world</b> & more" });
    const relayed = waitFor(b.socket, "stroke:commit");
    expect(await emitAck(a.socket, "stroke:commit", t)).toEqual({ ok: true });
    expect(await relayed).toMatchObject({ kind: "text", text: "Hello <b>world</b> & more" });
    const late = await joinAs(srv, board.id, "Late");
    expect(late.ack.strokes[0]).toMatchObject({ kind: "text", text: "Hello <b>world</b> & more", points: [[50, 60]] });
  });

  it("a stroke without kind is a pen", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const s = stroke();
    await emitAck(a.socket, "stroke:commit", s);
    expect((await srv.prisma.stroke.findUniqueOrThrow({ where: { id: s.id } })).kind).toBe("pen");
  });

  const bad: [string, Record<string, unknown>][] = [
    ["line with one point", shape("line", { points: [[1, 1]] })],
    ["line with three points", shape("line", { points: [[1, 1], [2, 2], [3, 3]] })],
    ["rect with one point", shape("rect", { points: [[1, 1]] })],
    ["ellipse with three points", shape("ellipse", { points: [[1, 1], [2, 2], [3, 3]] })],
    ["text with two points", textStroke({ points: [[1, 1], [2, 2]] })],
    ["text without content", textStroke({ text: undefined })],
    ["text with empty content", textStroke({ text: "" })],
    ["text over 200 characters", textStroke({ text: "x".repeat(201) })],
    ["text with a control character", textStroke({ text: "a\u0007b" })],
    ["text on a pen stroke", stroke({ text: "nope" })],
    ["text on a shape", shape("rect", { text: "nope" })],
    ["unknown kind", shape("polygon")],
    ["kind of the wrong type", shape("rect", { kind: 5 })],
  ];
  it.each(bad)("rejects %s", async (_n, payload) => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    expect(await emitAck(a.socket, "stroke:commit", payload)).toEqual({ ok: false, error: "invalid" });
    expect(await srv.prisma.stroke.count({ where: { boardId: board.id } })).toBe(0);
  });

  it("accepts text of exactly 200 characters", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    expect(await emitAck(a.socket, "stroke:commit", textStroke({ text: "x".repeat(200) }))).toEqual({ ok: true });
  });

  it("relays live progress of a shape with its kind, and refuses progress for text", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const b = await joinAs(srv, board.id, "Bob");
    const got = waitFor(b.socket, "stroke:progress");
    a.socket.emit("stroke:progress", shape("rect"));
    expect(await got).toMatchObject({ kind: "rect", points: [[100, 100], [300, 200]] });
    const none = record(b.socket, ["stroke:progress"]);
    a.socket.emit("stroke:progress", textStroke());
    a.socket.emit("stroke:progress", shape("line", { points: [[1, 1], [2, 2], [3, 3]] }));
    await sleep(300);
    expect(none).toEqual([]);
  });

  it("the eraser path: an author removes a shape with the normal undo, others cannot", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const b = await joinAs(srv, board.id, "Bob");
    const s = shape("ellipse");
    await emitAck(a.socket, "stroke:commit", s);
    expect(await emitAck(b.socket, "stroke:undo", { id: s.id })).toEqual({ ok: false, error: "forbidden" });
    expect(await emitAck(a.socket, "stroke:undo", { id: s.id })).toEqual({ ok: true });
  });

  it("redo: the same stroke id can be committed again after it was removed", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const s = shape("line");
    await emitAck(a.socket, "stroke:commit", s);
    await emitAck(a.socket, "stroke:undo", { id: s.id });
    expect(await emitAck(a.socket, "stroke:commit", s)).toEqual({ ok: true });
    const rows = await srv.prisma.stroke.findMany({ where: { id: s.id } });
    expect(rows).toHaveLength(1);
  });

  it("a stroke id that is still stored by someone else cannot be committed by another author", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const b = await joinAs(srv, board.id, "Bob");
    const s = shape("line", { id: uuid() });
    await emitAck(a.socket, "stroke:commit", s);
    expect(await emitAck(b.socket, "stroke:commit", s)).toEqual({ ok: false, error: "forbidden" });
  });
});
