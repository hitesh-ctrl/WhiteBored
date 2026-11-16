import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoard, createOwnedBoard, emitAck, joinAs, joinWith, record, sha256, sleep, startTestServer, stroke, uuid, waitFor, type TestServer } from "./helpers";

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

const viewer = (srvx: TestServer, viewId: string, name = "Vic") => joinWith(srvx, { viewId, clientId: uuid(), name });

describe("join roles", () => {
  it("an editor gets role, boardName, canClear and the view-only id", async () => {
    const board = await createBoard(srv.prisma, "My board");
    const a = await joinAs(srv, board.id, "Ann");
    expect(a.ack).toMatchObject({ ok: true, role: "editor", canClear: true, viewId: board.viewId, boardName: "My board" });
  });

  it("a viewer joins by viewId, sees history, and is not told the board id or the view id", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const s = stroke();
    await emitAck(a.socket, "stroke:commit", s);
    const v = await viewer(srv, board.viewId);
    expect(v.ack).toMatchObject({ ok: true, role: "viewer", canClear: false });
    expect(v.ack.strokes.map((x: any) => x.id)).toEqual([s.id]);
    expect(v.ack.viewId).toBeUndefined();
    expect(JSON.stringify(v.ack)).not.toContain(board.id);
  });

  it("rejects joins that give both ids, neither id, or an unknown viewId", async () => {
    const board = await createBoard(srv.prisma);
    const base = { clientId: uuid(), name: "X" };
    expect((await joinWith(srv, { ...base, boardId: board.id, viewId: board.viewId })).ack).toEqual({ ok: false, error: "invalid" });
    expect((await joinWith(srv, { ...base })).ack).toEqual({ ok: false, error: "invalid" });
    expect((await joinWith(srv, { ...base, viewId: uuid() })).ack).toEqual({ ok: false, error: "not_found" });
    // the edit id is not accepted as a view id
    expect((await joinWith(srv, { ...base, viewId: board.id })).ack).toEqual({ ok: false, error: "not_found" });
  });
});

describe("viewers are read-only", () => {
  it("cannot commit, undo, clear or rename, and nothing changes", async () => {
    const board = await createBoard(srv.prisma, "Keep me");
    const a = await joinAs(srv, board.id, "Ann");
    const s = stroke();
    await emitAck(a.socket, "stroke:commit", s);
    const v = await viewer(srv, board.viewId);
    expect(await emitAck(v.socket, "stroke:commit", stroke())).toEqual({ ok: false, error: "forbidden" });
    expect(await emitAck(v.socket, "stroke:undo", { id: s.id })).toEqual({ ok: false, error: "forbidden" });
    expect(await emitAck(v.socket, "board:clear")).toEqual({ ok: false, error: "forbidden" });
    expect(await emitAck(v.socket, "board:rename", { name: "Hacked" })).toEqual({ ok: false, error: "forbidden" });
    expect(await srv.prisma.stroke.count({ where: { boardId: board.id } })).toBe(1);
    expect((await srv.prisma.board.findUniqueOrThrow({ where: { id: board.id } })).name).toBe("Keep me");
  });

  it("a viewer that shares a client id with an author (same browser tab) still cannot undo that author's stroke", async () => {
    const board = await createBoard(srv.prisma);
    const author = uuid();
    const a = await joinAs(srv, board.id, "Ann", author);
    const s = stroke();
    await emitAck(a.socket, "stroke:commit", s);
    const v = await joinWith(srv, { viewId: board.viewId, clientId: author, name: "Ann (view)" });
    expect(await emitAck(v.socket, "stroke:undo", { id: s.id })).toEqual({ ok: false, error: "forbidden" });
    expect(await srv.prisma.stroke.count({ where: { id: s.id } })).toBe(1);
  });

  it("cannot send live progress to the others", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const got = record(a.socket, ["stroke:progress"]);
    const v = await viewer(srv, board.viewId);
    v.socket.emit("stroke:progress", stroke());
    await sleep(300);
    expect(got).toEqual([]);
  });

  it("receives live strokes, progress, removals and clears", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const v = await viewer(srv, board.viewId);
    const s = stroke();
    const prog = waitFor(v.socket, "stroke:progress");
    a.socket.emit("stroke:progress", s);
    await prog;
    const commit = waitFor(v.socket, "stroke:commit");
    await emitAck(a.socket, "stroke:commit", s);
    expect((await commit).id).toBe(s.id);
    const removed = waitFor(v.socket, "stroke:remove");
    await emitAck(a.socket, "stroke:undo", { id: s.id });
    expect(await removed).toEqual({ id: s.id });
    const cleared = waitFor(v.socket, "board:cleared");
    await emitAck(a.socket, "board:clear");
    await cleared;
  });

  it("can still show a cursor and a laser to the others", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const v = await viewer(srv, board.viewId, "Vic");
    const cur = waitFor(a.socket, "cursor:move");
    v.socket.emit("cursor:move", { x: 1, y: 2 });
    expect(await cur).toMatchObject({ name: "Vic", x: 1, y: 2 });
    const las = waitFor(a.socket, "laser:move");
    v.socket.emit("laser:move", { x: 3, y: 4 });
    expect(await las).toMatchObject({ name: "Vic", x: 3, y: 4 });
  });
});

describe("owner", () => {
  it("the correct key gives role owner; a missing or wrong key gives a plain editor", async () => {
    const { board, ownerKey } = await createOwnedBoard(srv.prisma);
    const base = { boardId: board.id, name: "X" };
    expect((await joinWith(srv, { ...base, clientId: uuid(), ownerKey })).ack).toMatchObject({ ok: true, role: "owner", canClear: true });
    expect((await joinWith(srv, { ...base, clientId: uuid() })).ack).toMatchObject({ ok: true, role: "editor", canClear: false });
    expect((await joinWith(srv, { ...base, clientId: uuid(), ownerKey: "wrong-key-wrong-key" })).ack).toMatchObject({ ok: true, role: "editor", canClear: false });
  });

  it("never echoes the owner key or its hash", async () => {
    const { board, ownerKey } = await createOwnedBoard(srv.prisma);
    const j = await joinWith(srv, { boardId: board.id, clientId: uuid(), name: "O", ownerKey });
    const text = JSON.stringify(j.ack);
    expect(text).not.toContain(ownerKey);
    expect(text).not.toContain(sha256(ownerKey));
  });

  it("an owned board can only be cleared by its owner", async () => {
    const { board, ownerKey } = await createOwnedBoard(srv.prisma);
    const editor = await joinAs(srv, board.id, "Ed");
    const owner = (await joinWith(srv, { boardId: board.id, clientId: uuid(), name: "Own", ownerKey })).socket;
    await emitAck(editor.socket, "stroke:commit", stroke());
    expect(await emitAck(editor.socket, "board:clear")).toEqual({ ok: false, error: "forbidden" });
    expect(await srv.prisma.stroke.count({ where: { boardId: board.id } })).toBe(1);
    const cleared = waitFor(editor.socket, "board:cleared");
    expect(await emitAck(owner, "board:clear")).toEqual({ ok: true });
    await cleared;
    expect(await srv.prisma.stroke.count({ where: { boardId: board.id } })).toBe(0);
  });

  it("a board without an owner keeps the old rule: any editor may clear", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    expect(await emitAck(a.socket, "board:clear")).toEqual({ ok: true });
  });
});

describe("rename", () => {
  it("the owner renames; the others are told; the name is stored", async () => {
    const { board, ownerKey } = await createOwnedBoard(srv.prisma, "Old");
    const editor = await joinAs(srv, board.id, "Ed");
    const owner = (await joinWith(srv, { boardId: board.id, clientId: uuid(), name: "Own", ownerKey })).socket;
    const told = waitFor(editor.socket, "board:renamed");
    expect(await emitAck(owner, "board:rename", { name: "  New name  " })).toEqual({ ok: true });
    expect(await told).toEqual({ name: "New name" });
    expect((await srv.prisma.board.findUniqueOrThrow({ where: { id: board.id } })).name).toBe("New name");
  });

  it("editors cannot rename, and a bad name is invalid", async () => {
    const { board, ownerKey } = await createOwnedBoard(srv.prisma, "Old");
    const editor = await joinAs(srv, board.id, "Ed");
    expect(await emitAck(editor.socket, "board:rename", { name: "Nope" })).toEqual({ ok: false, error: "forbidden" });
    const owner = (await joinWith(srv, { boardId: board.id, clientId: uuid(), name: "Own", ownerKey })).socket;
    expect(await emitAck(owner, "board:rename", { name: "" })).toEqual({ ok: false, error: "invalid" });
    expect(await emitAck(owner, "board:rename", { name: "x".repeat(31) })).toEqual({ ok: false, error: "invalid" });
    expect(await emitAck(owner, "board:rename", { name: 5 })).toEqual({ ok: false, error: "invalid" });
    expect((await srv.prisma.board.findUniqueOrThrow({ where: { id: board.id } })).name).toBe("Old");
  });

  it("a board without an owner cannot be renamed", async () => {
    const board = await createBoard(srv.prisma, "Legacy");
    const a = await joinAs(srv, board.id, "Ann");
    expect(await emitAck(a.socket, "board:rename", { name: "Nope" })).toEqual({ ok: false, error: "forbidden" });
  });
});

describe("laser", () => {
  it("is relayed to the others with the sender's name and never echoed back", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const b = await joinAs(srv, board.id, "Bob");
    const echo = record(a.socket, ["laser:move"]);
    const got = waitFor(b.socket, "laser:move");
    a.socket.volatile.emit("laser:move", { x: 10, y: 20 });
    expect(await got).toEqual({ id: a.clientId, name: "Ann", x: 10, y: 20 });
    await sleep(300);
    expect(echo).toEqual([]);
  });

  it("ignores laser positions outside the canvas and from sockets that have not joined", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    const got = record(a.socket, ["laser:move"]);
    const b = await joinAs(srv, board.id, "Bob");
    b.socket.emit("laser:move", { x: 99999, y: 1 });
    const lone = await srv.connect();
    lone.emit("laser:move", { x: 1, y: 1 });
    await sleep(300);
    expect(got).toEqual([]);
  });
});
