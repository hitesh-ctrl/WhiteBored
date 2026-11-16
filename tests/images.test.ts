import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_IMAGES_PER_BOARD, MAX_IMAGE_BYTES_PER_BOARD } from "../src/shared/limits";
import { createBoard, createOwnedBoard, emitAck, joinAs, joinWith, record, sleep, startTestServer, uuid, waitFor, type TestServer } from "./helpers";
import { gif, jpeg, png, svg, webpL } from "./imageFixtures";

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

const geo = { x: 100, y: 80, w: 400, h: 300, opacity: 40 };
const tpl = (over: Record<string, unknown> = {}) => ({ id: uuid(), template: "house", ...geo, ...over });
const upload = (data: Buffer, over: Record<string, unknown> = {}) => ({ id: uuid(), data, ...geo, ...over });
const KEY = "image-key-image-key-0123456789ab";

async function setup() {
  const board = await createBoard(srv.prisma);
  const a = await joinAs(srv, board.id, "Ann");
  const b = await joinAs(srv, board.id, "Bob");
  return { board, a, b };
}

describe("adding a built-in picture", () => {
  it("stores only the key, tells the others (not the sender), and a late joiner or viewer gets it in the join acknowledgement without any bytes", async () => {
    const { board, a, b } = await setup();
    const echo = record(a.socket, ["image:added"]);
    const told = waitFor(b.socket, "image:added");
    const req = tpl();
    const ack = await emitAck(a.socket, "image:add", req);
    expect(ack).toMatchObject({ ok: true, image: { id: req.id, authorId: a.clientId, template: "house", ...geo } });
    expect(await told).toMatchObject({ id: req.id, template: "house" });
    const row = await srv.prisma.boardImage.findUniqueOrThrow({ where: { id: req.id } });
    expect(row).toMatchObject({ boardId: board.id, authorId: a.clientId, template: "house", data: null, byteSize: 0 });
    const late = await joinAs(srv, board.id, "Late");
    expect(late.ack.images).toEqual([expect.objectContaining({ id: req.id, template: "house" })]);
    const v = await joinWith(srv, { viewId: board.viewId, clientId: uuid(), name: "Vic" });
    expect(v.ack.images).toHaveLength(1);
    expect(JSON.stringify(late.ack.images)).not.toContain("data");
    await sleep(200);
    expect(echo).toEqual([]);
  });
  it.each([["unknown key", "dragon"], ["inherited name", "constructor"], ["wrong case", "House"], ["empty", ""]])("rejects a template with a %s", async (_n, key) => {
    const { a } = await setup();
    expect(await emitAck(a.socket, "image:add", tpl({ template: key }))).toEqual({ ok: false, error: "invalid" });
  });
  it("needs exactly one of template and data", async () => {
    const { a } = await setup();
    expect(await emitAck(a.socket, "image:add", tpl({ data: jpeg(10, 10) }))).toEqual({ ok: false, error: "invalid" });
    expect(await emitAck(a.socket, "image:add", { id: uuid(), ...geo })).toEqual({ ok: false, error: "invalid" });
  });
});

describe("uploading a picture", () => {
  it.each([["jpeg", () => jpeg(800, 600, 3000), "image/jpeg"], ["png", () => png(640, 480, 2000), "image/png"], ["webp", () => webpL(300, 200, 1500), "image/webp"]])("keeps a %s as sent, with the type read from its bytes", async (_n, make, mime) => {
    const { a, b } = await setup();
    const data = make();
    const told = waitFor(b.socket, "image:added");
    const req = upload(data);
    const ack = await emitAck(a.socket, "image:add", req);
    expect(ack.ok).toBe(true);
    expect(ack.image.mime).toBe(mime);
    expect(ack.image.data).toBeUndefined();
    expect((await told).mime).toBe(mime);
    const row = await srv.prisma.boardImage.findUniqueOrThrow({ where: { id: req.id } });
    expect(Buffer.from(row.data!).equals(data)).toBe(true);
    expect(row).toMatchObject({ mime, byteSize: data.length, template: null });
  });

  const bad: [string, () => unknown][] = [
    ["a GIF", () => upload(gif())],
    ["an SVG that carries a script", () => upload(svg())],
    ["plain text", () => upload(Buffer.from("hello"))],
    ["text that claims a picture type", () => upload(Buffer.from("<html>"), { mime: "image/png" })],
    ["a picture over 4096 pixels wide", () => upload(png(4097, 10))],
    ["a picture with more than 8 million pixels", () => upload(png(4000, 3000))],
    ["a tiny file that claims a huge picture", () => upload(png(60000, 60000, 100))],
    ["a picture with no size", () => upload(png(0, 10))],
    ["a file over 400 KB", () => upload(png(100, 100, 400 * 1024 + 1))],
    ["data that is not binary", () => ({ id: uuid(), data: "AAAA", ...geo })],
    ["an x outside the board area", () => tpl({ x: 99999 })],
    ["a width that is too small", () => tpl({ w: 5 })],
    ["a height that is too large", () => tpl({ h: 99999 })],
    ["an opacity of 0", () => tpl({ opacity: 0 })],
    ["an opacity over 100", () => tpl({ opacity: 101 })],
    ["a fractional opacity", () => tpl({ opacity: 50.5 })],
    ["an id that is not a uuid", () => tpl({ id: "x" })],
  ];
  it.each(bad)("rejects %s and stores nothing", async (_n, make) => {
    const { board, a } = await setup();
    expect(await emitAck(a.socket, "image:add", make())).toEqual({ ok: false, error: "invalid" });
    expect(await srv.prisma.boardImage.count({ where: { boardId: board.id } })).toBe(0);
  });

  it("drops the connection for a message over 512 KB and stores nothing", async () => {
    const { board, a } = await setup();
    const closed = new Promise<string>((r) => a.socket.once("disconnect", (reason) => r(reason)));
    a.socket.emit("image:add", upload(jpeg(100, 100, 600 * 1024)));
    expect(await Promise.race([closed, sleep(4000).then(() => "NOT CLOSED")])).not.toBe("NOT CLOSED");
    expect(await srv.prisma.boardImage.count({ where: { boardId: board.id } })).toBe(0);
  });
});

describe("who may add, change and remove a picture", () => {
  it("viewers may not add, update or remove", async () => {
    const { board, a } = await setup();
    const req = tpl();
    await emitAck(a.socket, "image:add", req);
    const v = await joinWith(srv, { viewId: board.viewId, clientId: uuid(), name: "Vic" });
    expect(await emitAck(v.socket, "image:add", tpl())).toEqual({ ok: false, error: "forbidden" });
    expect(await emitAck(v.socket, "image:update", { id: req.id, ...geo, x: 5 })).toEqual({ ok: false, error: "forbidden" });
    expect(await emitAck(v.socket, "image:remove", { id: req.id })).toEqual({ ok: false, error: "forbidden" });
    expect(await srv.prisma.boardImage.count({ where: { boardId: board.id } })).toBe(1);
  });

  it("the author updates and removes their picture, and the others are told", async () => {
    const { a, b } = await setup();
    const req = tpl();
    await emitAck(a.socket, "image:add", req);
    await sleep(150);
    const updated = waitFor(b.socket, "image:updated");
    const ack = await emitAck(a.socket, "image:update", { id: req.id, x: 10, y: 20, w: 500, h: 250, opacity: 70 });
    expect(ack).toMatchObject({ ok: true, image: { id: req.id, x: 10, y: 20, w: 500, h: 250, opacity: 70 } });
    expect(await updated).toMatchObject({ id: req.id, w: 500, opacity: 70 });
    expect(await srv.prisma.boardImage.findUniqueOrThrow({ where: { id: req.id } })).toMatchObject({ x: 10, w: 500, opacity: 70 });
    const removed = waitFor(b.socket, "image:removed");
    expect(await emitAck(a.socket, "image:remove", { id: req.id })).toEqual({ ok: true });
    expect(await removed).toEqual({ id: req.id });
    expect(await srv.prisma.boardImage.count({ where: { id: req.id } })).toBe(0);
  });

  it("another editor cannot change or remove it, and nothing changes", async () => {
    const { a, b } = await setup();
    const req = tpl();
    await emitAck(a.socket, "image:add", req);
    expect(await emitAck(b.socket, "image:update", { id: req.id, ...geo, x: 1 })).toEqual({ ok: false, error: "forbidden" });
    expect(await emitAck(b.socket, "image:remove", { id: req.id })).toEqual({ ok: false, error: "forbidden" });
    expect((await srv.prisma.boardImage.findUniqueOrThrow({ where: { id: req.id } })).x).toBe(geo.x);
  });

  it("the board owner can change and remove anyone's picture", async () => {
    const { board, ownerKey } = await createOwnedBoard(srv.prisma);
    const guest = await joinAs(srv, board.id, "Guest");
    const owner = (await joinWith(srv, { boardId: board.id, clientId: uuid(), name: "Own", ownerKey })).socket;
    const req = tpl();
    await emitAck(guest.socket, "image:add", req);
    expect((await emitAck(owner, "image:update", { id: req.id, ...geo, x: 7 })).ok).toBe(true);
    expect(await emitAck(owner, "image:remove", { id: req.id })).toEqual({ ok: true });
  });

  it("a stranger with the author's public client id but another key cannot change it", async () => {
    const board = await createBoard(srv.prisma);
    const id = uuid();
    const a = await joinWith(srv, { boardId: board.id, clientId: id, name: "Ann", clientKey: KEY });
    const req = tpl();
    await emitAck(a.socket, "image:add", req);
    expect((await srv.prisma.boardImage.findUniqueOrThrow({ where: { id: req.id } })).authorProof).not.toBeNull();
    a.socket.close();
    await sleep(200);
    const m = await joinWith(srv, { boardId: board.id, clientId: id, name: "Mallory", clientKey: "x".repeat(32) });
    expect(await emitAck(m.socket, "image:update", { id: req.id, ...geo, x: 1 })).toEqual({ ok: false, error: "forbidden" });
    expect(await emitAck(m.socket, "image:remove", { id: req.id })).toEqual({ ok: false, error: "forbidden" });
  });

  it("an unknown picture, or one on another board, is forbidden", async () => {
    const { a } = await setup();
    const other = await createBoard(srv.prisma);
    const c = await joinAs(srv, other.id, "Cat", a.clientId);
    const req = tpl();
    await emitAck(c.socket, "image:add", req);
    for (const id of [uuid(), req.id]) {
      expect(await emitAck(a.socket, "image:update", { id, ...geo })).toEqual({ ok: false, error: "forbidden" });
      expect(await emitAck(a.socket, "image:remove", { id })).toEqual({ ok: false, error: "forbidden" });
    }
  });

  it("validates updates and removals", async () => {
    const { a } = await setup();
    expect(await emitAck(a.socket, "image:update", { id: uuid(), x: 1 })).toEqual({ ok: false, error: "invalid" });
    expect(await emitAck(a.socket, "image:update", { id: "x", ...geo })).toEqual({ ok: false, error: "invalid" });
    expect(await emitAck(a.socket, "image:remove", { id: 5 })).toEqual({ ok: false, error: "invalid" });
    const lone = await srv.connect();
    expect(await emitAck(lone, "image:add", tpl())).toEqual({ ok: false, error: "not_joined" });
  });
});

describe("limits and retries", () => {
  it(`allows ${MAX_IMAGES_PER_BOARD} pictures per board and refuses the next`, async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    await srv.prisma.boardImage.createMany({ data: Array.from({ length: MAX_IMAGES_PER_BOARD - 1 }, () => ({ id: uuid(), boardId: board.id, authorId: uuid(), template: "star", ...geo })) });
    expect((await emitAck(a.socket, "image:add", tpl())).ok).toBe(true);
    expect(await emitAck(a.socket, "image:add", tpl())).toEqual({ ok: false, error: "board_full" });
  });
  it("limits the uploaded bytes per board, but not built-in pictures", async () => {
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    await srv.prisma.boardImage.create({ data: { id: uuid(), boardId: board.id, authorId: uuid(), mime: "image/png", data: Buffer.from([1]), byteSize: MAX_IMAGE_BYTES_PER_BOARD - 1000, ...geo } });
    expect(await emitAck(a.socket, "image:add", upload(jpeg(100, 100, 5000)))).toEqual({ ok: false, error: "board_full" });
    expect((await emitAck(a.socket, "image:add", tpl())).ok).toBe(true);
  });
  it("a repeated add by the author is accepted once and relayed once; another author's id is refused", async () => {
    const { a, b } = await setup();
    const got = record(b.socket, ["image:added"]);
    const req = tpl();
    expect((await emitAck(a.socket, "image:add", req)).ok).toBe(true);
    expect((await emitAck(a.socket, "image:add", req)).ok).toBe(true);
    expect(await emitAck(b.socket, "image:add", req)).toEqual({ ok: false, error: "forbidden" });
    await sleep(300);
    expect(got).toHaveLength(1);
    expect(await srv.prisma.boardImage.count({ where: { id: req.id } })).toBe(1);
  });
  it("adding pictures is rate limited per connection", async () => {
    const { a } = await setup();
    const acks = await Promise.all(Array.from({ length: 12 }, () => emitAck(a.socket, "image:add", tpl({ template: "star" }))));
    expect(acks.some((x) => x.error === "rate_limited")).toBe(true);
  });
});

describe("pictures and the rest of the board", () => {
  it("clearing the board keeps its pictures", async () => {
    const { board, a } = await setup();
    await emitAck(a.socket, "image:add", tpl());
    expect((await emitAck(a.socket, "board:clear")).ok).toBe(true);
    expect(await srv.prisma.boardImage.count({ where: { boardId: board.id } })).toBe(1);
  });
  it("deleting a board deletes its pictures", async () => {
    const { board, a } = await setup();
    await emitAck(a.socket, "image:add", upload(jpeg(100, 100, 2000)));
    await srv.prisma.board.delete({ where: { id: board.id } });
    expect(await srv.prisma.boardImage.count({ where: { boardId: board.id } })).toBe(0);
  });
});
