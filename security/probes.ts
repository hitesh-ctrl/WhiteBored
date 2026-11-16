import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { io, type Socket } from "socket.io-client";
import { createPrisma } from "../src/lib/prisma";
import { SOCKET, SOCKET_PORT, WEB, assertPortFree, exited, sleep, startSocketServer, waitHttp } from "../e2e/lib";

const results: { probe: string; pass: boolean; detail: string }[] = [];
async function probe(name: string, fn: () => Promise<string>) {
  try { const d = await fn(); results.push({ probe: name, pass: true, detail: d }); console.log(`PASS ${name}: ${d}`); }
  catch (e) { results.push({ probe: name, pass: false, detail: String(e) }); console.log(`FAIL ${name}: ${e}`); }
}
const must = (c: unknown, msg: string) => { if (!c) throw new Error(msg); };
const health = async () => (await fetch(`${SOCKET}/health`)).status === 200;

await assertPortFree(SOCKET_PORT);
const prisma = createPrisma();
const board = await prisma.board.create({ data: { name: "probe board" } });
const other = await prisma.board.create({ data: { name: "probe board 2" } });
const server = startSocketServer();
await waitHttp(`${SOCKET}/health`);

const open: Socket[] = [];
const connect = async (extra: Record<string, string> = {}) => {
  const s = io(SOCKET, { transports: ["websocket"], forceNew: true, reconnection: false, extraHeaders: extra });
  open.push(s);
  await new Promise<void>((res, rej) => { s.once("connect", () => res()); s.once("connect_error", rej); });
  return s;
};
const join = async (boardId: string, name: string, clientId = randomUUID()) => {
  const s = await connect();
  const ack = await s.emitWithAck("board:join", { boardId, clientId, name });
  return { s, ack, clientId };
};
const stroke = (over = {}) => ({ id: randomUUID(), color: "#112233", width: 4, points: [[1, 1], [2, 2]], ...over });
const ackEvents = ["board:join", "stroke:commit", "stroke:undo", "board:clear", "board:rename"] as const;
const plain = ["stroke:progress", "cursor:move", "laser:move"] as const;

let deep: unknown = "x";
for (let i = 0; i < 60; i++) deep = { a: deep };
const garbage: unknown[] = [null, undefined, 42, -1, NaN, true, "x", "A".repeat(5000), [], [[]], {}, { id: {} }, { points: "no" }, deep, "'; DROP TABLE \"Stroke\"; --"];

await probe("malformed payloads never crash the server and never succeed (before and after join)", async () => {
  const pre = await connect();
  const post = (await join(board.id, "Prober")).s;
  let sent = 0, okAcks = 0;
  for (const s of [pre, post]) {
    for (const ev of ackEvents) {
      for (const g of garbage) {
        if (ev === "board:clear" && s === post) continue; // a valid clear on a joined socket is legal (legacy board)
        if (ev === "board:join" && s === post) continue;
        const ack = await s.timeout(2000).emitWithAck(ev, g).catch(() => ({ ok: "timeout" }));
        sent++;
        if ((ack as { ok: unknown }).ok === true) okAcks++;
        await sleep(60); // stay under the per-socket limits so we test validation, not throttling
      }
    }
    for (const ev of plain) for (const g of garbage) { s.emit(ev, g); sent++; }
  }
  await sleep(300);
  must(okAcks === 0, `${okAcks} malformed messages were accepted`);
  must(await health(), "server died");
  must(post.connected, "joined socket was dropped");
  return `${sent} malformed messages sent, 0 accepted, server healthy`;
});

await probe("oversized payload (over maxHttpBufferSize 256 KB) closes the connection and stores nothing", async () => {
  const { s } = await join(board.id, "Big");
  const closed = new Promise<string>((r) => s.once("disconnect", (reason) => r(reason)));
  const huge = stroke({ points: Array.from({ length: 40000 }, () => [100.5, 100.5]) });
  const bytes = JSON.stringify(huge).length;
  s.emit("stroke:commit", huge);
  const reason = await Promise.race([closed, sleep(4000).then(() => "NOT CLOSED")]);
  must(reason !== "NOT CLOSED", "connection stayed open");
  must((await prisma.stroke.count({ where: { id: huge.id } })) === 0, "oversized stroke stored");
  must(await health(), "server died");
  return `${bytes} byte message, disconnect reason "${reason}"`;
});

await probe("message flood from one socket is throttled and does not hurt other clients", async () => {
  const flood = (await join(board.id, "Flooder")).s;
  const watcher = await join(board.id, "Watcher");
  let seenProgress = 0, seenCursor = 0;
  watcher.s.on("stroke:progress", () => seenProgress++);
  watcher.s.on("cursor:move", () => seenCursor++);
  const N = 20000;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) { flood.emit("stroke:progress", stroke()); if (i % 4 === 0) flood.emit("cursor:move", { x: 5, y: 5 }); }
  const commitAcks: number[] = [];
  for (let i = 0; i < 5; i++) { const t = Date.now(); const a = await watcher.s.timeout(5000).emitWithAck("stroke:commit", stroke()); must(a.ok, "watcher commit failed during flood"); commitAcks.push(Date.now() - t); }
  await sleep(1000);
  const dur = (Date.now() - t0) / 1000;
  must(seenProgress < 400, `${seenProgress} progress events relayed`);
  must(await health(), "server died");
  return `sent ${N} progress + ${N / 4} cursor in ${dur.toFixed(1)} s; peer saw ${seenProgress} progress and ${seenCursor} cursor events; watcher commit acks during flood ${commitAcks.join("/")} ms`;
});

await probe("join of a non-existent board, and injection-style ids", async () => {
  const s = await connect();
  const a1 = await s.emitWithAck("board:join", { boardId: randomUUID(), clientId: randomUUID(), name: "X" });
  must(a1.error === "not_found", `got ${JSON.stringify(a1)}`);
  await sleep(600);
  const a2 = await s.emitWithAck("board:join", { boardId: "' OR '1'='1", clientId: randomUUID(), name: "X" });
  must(a2.error === "invalid", `got ${JSON.stringify(a2)}`);
  return "not_found for unknown uuid, invalid for injection string";
});

await probe("SQL-injection style names and values are inert", async () => {
  const before = await prisma.board.count();
  const evil = `x'); DROP TABLE "Board"; --`;
  const a = await join(board.id, evil);
  must(a.ack.ok, "join with SQL-looking name failed");
  must(a.ack.users.some((u: { name: string }) => u.name === evil), "name was altered");
  const bad = await a.s.emitWithAck("stroke:commit", stroke({ color: "#000'; DROP TABLE \"Stroke\";--" }));
  must(bad.error === "invalid", "injection colour accepted");
  must((await prisma.board.count()) === before, "board count changed");
  await prisma.stroke.count();
  return "name kept verbatim as text, injected colour rejected, tables intact";
});

await probe("undo of another user's stroke and of a stroke on another board is refused", async () => {
  const a = await join(board.id, "Ann");
  await sleep(300);
  const b = await join(board.id, "Bob");
  const c = await join(other.id, "Cat", a.clientId); // same client id, other board
  const s = stroke();
  must((await a.s.emitWithAck("stroke:commit", s)).ok, "commit failed");
  const r1 = await b.s.emitWithAck("stroke:undo", { id: s.id });
  const r2 = await c.s.emitWithAck("stroke:undo", { id: s.id });
  must(r1.error === "forbidden" && r2.error === "forbidden", `${JSON.stringify([r1, r2])}`);
  must((await prisma.stroke.count({ where: { id: s.id } })) === 1, "stroke was deleted");
  return "both undo attempts got forbidden, row still present";
});

await probe("spoofed author, board and name in a message are ignored", async () => {
  const a = await join(board.id, "Honest");
  const victim = randomUUID();
  const s = { ...stroke(), authorId: victim, boardId: other.id, name: "Admin", clientId: victim };
  await sleep(300);
  must((await a.s.emitWithAck("stroke:commit", s)).ok, "commit failed");
  const row = await prisma.stroke.findUnique({ where: { id: s.id } });
  must(row?.authorId === a.clientId && row?.boardId === board.id, `stored ${JSON.stringify(row && { a: row.authorId, b: row.boardId })}`);
  return "stored with the connection's own identity and board";
});

await probe("CORS: wrong origin refused, configured origin allowed, no wildcard", async () => {
  const url = `${SOCKET}/socket.io/?EIO=4&transport=polling`;
  const evil = await fetch(url, { headers: { Origin: "http://evil.example" } });
  const good = await fetch(url, { headers: { Origin: WEB } });
  const pre = await fetch(url, { method: "OPTIONS", headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "GET" } });
  must(evil.status === 403, `evil polling status ${evil.status}`);
  must(good.status === 200, `good status ${good.status}`);
  must(good.headers.get("access-control-allow-origin") === WEB, `ACAO ${good.headers.get("access-control-allow-origin")}`);
  must(pre.headers.get("access-control-allow-origin") !== "*" && pre.headers.get("access-control-allow-origin") !== "http://evil.example", "preflight allowed evil origin");
  let wsBlocked = false;
  try { await connect({ Origin: "http://evil.example" }); } catch { wsBlocked = true; }
  must(wsBlocked, "websocket from wrong origin connected");
  return `evil polling ${evil.status}, evil websocket blocked, good origin echoed, preflight not allowed for evil`;
});


await probe("a view-only socket cannot change anything, whatever it sends", async () => {
  const b = await prisma.board.create({ data: { name: "viewer probe" } });
  const editor = await join(b.id, "Editor");
  const kept = stroke();
  must((await editor.s.emitWithAck("stroke:commit", kept)).ok, "setup commit failed");
  const v = await connect();
  const j = await v.emitWithAck("board:join", { viewId: b.viewId, clientId: randomUUID(), name: "Viewer" });
  must(j.ok && j.role === "viewer", `join ${JSON.stringify(j)}`);
  const seen: string[] = [];
  editor.s.on("stroke:progress", () => seen.push("progress"));
  editor.s.on("stroke:commit", () => seen.push("commit"));
  editor.s.on("board:cleared", () => seen.push("cleared"));
  editor.s.on("board:renamed", () => seen.push("renamed"));
  const attempts = [
    ["stroke:commit", stroke()], ["stroke:undo", { id: kept.id }], ["board:clear", undefined],
    ["board:rename", { name: "owned" }], ["stroke:commit", stroke({ kind: "text", text: "hi", points: [[1, 1]] })],
  ] as const;
  const results: unknown[] = [];
  for (const [ev, payload] of attempts) { results.push((await v.timeout(2000).emitWithAck(ev, payload).catch(() => "timeout")).error); await sleep(250); }
  v.emit("stroke:progress", stroke());
  await sleep(400);
  must(results.every((r) => r === "forbidden"), `acks ${JSON.stringify(results)}`);
  must(seen.length === 0, `editor saw ${seen}`);
  must((await prisma.stroke.count({ where: { boardId: b.id } })) === 1, "stroke count changed");
  must((await prisma.board.findUniqueOrThrow({ where: { id: b.id } })).name === "viewer probe", "board renamed");
  await prisma.board.delete({ where: { id: b.id } });
  return "commit, undo, clear, rename, text and progress all refused; board unchanged";
});

await probe("owner key guessing never grants owner rights", async () => {
  const realKey = "k".repeat(32);
  const hash = createHash("sha256").update(realKey).digest("hex");
  const b = await prisma.board.create({ data: { name: "owner probe", ownerHash: hash } });
  const guesses: unknown[] = [hash, "x".repeat(128), "a".repeat(16), realKey.slice(1), realKey.toUpperCase(), "", null, [realKey], { $ne: 1 }, realKey + " "];
  const roles: string[] = [];
  for (const g of guesses) {
    const s = await connect();
    const a = await s.emitWithAck("board:join", { boardId: b.id, clientId: randomUUID(), name: "G", ownerKey: g });
    roles.push(a.ok ? `${a.role}/${a.canClear}` : `rejected:${a.error}`);
    const c = a.ok ? await s.emitWithAck("board:clear") : { ok: false };
    must(!c.ok, `clear worked with guess ${JSON.stringify(g)}`);
    s.close();
    await sleep(120);
  }
  must(!roles.some((r) => r.startsWith("owner")), `roles ${roles}`);
  const good = await connect();
  const a = await good.emitWithAck("board:join", { boardId: b.id, clientId: randomUUID(), name: "Real", ownerKey: realKey });
  must(a.ok && a.role === "owner", "real key was refused");
  await prisma.board.delete({ where: { id: b.id } });
  return `${guesses.length} wrong keys gave ${[...new Set(roles)].join(", ")}; the real key gave owner`;
});

await probe("edit id and view id are not interchangeable", async () => {
  const b = await prisma.board.create({ data: { name: "id probe" } });
  const s1 = await connect();
  const a1 = await s1.emitWithAck("board:join", { viewId: b.id, clientId: randomUUID(), name: "X" });
  await sleep(300);
  const s2 = await connect();
  const a2 = await s2.emitWithAck("board:join", { boardId: b.viewId, clientId: randomUUID(), name: "X" });
  await sleep(300);
  const s3 = await connect();
  const a3 = await s3.emitWithAck("board:join", { boardId: b.id, viewId: b.viewId, clientId: randomUUID(), name: "X" });
  must(a1.error === "not_found" && a2.error === "not_found" && a3.error === "invalid", JSON.stringify([a1, a2, a3]));
  await prisma.board.delete({ where: { id: b.id } });
  return "view id as edit id and edit id as view id both not_found; both together invalid";
});


await probe("knowing a client id is not enough to delete that person's strokes or take their place", async () => {
  const b = await prisma.board.create({ data: { name: "identity probe" } });
  const victim = randomUUID();
  const v = await connect();
  const key = "v".repeat(32);
  const j = await v.emitWithAck("board:join", { boardId: b.id, clientId: victim, name: "Victim", clientKey: key });
  must(j.ok, "victim join failed");
  const st = stroke();
  must((await v.emitWithAck("stroke:commit", st)).ok, "commit failed");
  await sleep(300);
  // the attacker reads the victim's id from the board and tries to join as them, with and without a key
  const attacker = await connect();
  const a1 = await attacker.emitWithAck("board:join", { boardId: b.id, clientId: victim, name: "Impostor" });
  await sleep(300);
  const a2 = await attacker.emitWithAck("board:join", { boardId: b.id, clientId: victim, name: "Impostor", clientKey: "x".repeat(32) });
  must(a1.error === "forbidden" && a2.error === "forbidden", JSON.stringify([a1, a2]));
  // after the victim leaves, the id is free but the strokes still need the victim's key
  v.close();
  await sleep(400);
  const late = await connect();
  const a3 = await late.emitWithAck("board:join", { boardId: b.id, clientId: victim, name: "Impostor", clientKey: "x".repeat(32) });
  must(a3.ok, "join under a free id failed");
  const u = await late.emitWithAck("stroke:undo", { id: st.id });
  must(u.error === "forbidden", `undo gave ${JSON.stringify(u)}`);
  must((await prisma.stroke.count({ where: { id: st.id } })) === 1, "stroke was deleted");
  await prisma.board.delete({ where: { id: b.id } });
  return "join under a present id refused (with and without a key); undo without the key refused; stroke intact";
});


await probe("picture uploads: scripts, disguised files, files that lie about their size, floods and the storage cap", async () => {
  const b = await prisma.board.create({ data: { name: "upload probe" } });
  const u = await join(b.id, "Uploader");
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const png = (w: number, h: number, total = 0) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 2, 0, 0, 0, 0, 0, 0, 0, ...new Array(Math.max(0, total - 33)).fill(0)]);
  const geo = { x: 100, y: 100, w: 300, h: 200, opacity: 40 };
  const add = async (data: unknown, extra: Record<string, unknown> = {}) => (await u.s.timeout(4000).emitWithAck("image:add", { id: randomUUID(), data, ...geo, ...extra }).catch(() => ({ ok: "timeout" }))) as { ok: unknown; error?: string };
  const hostile: [string, unknown][] = [
    ["an SVG with a script", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ["HTML", Buffer.from("<html><script>alert(1)</script></html>")],
    ["a GIF", Buffer.from("GIF89a\x01\x00\x01\x00")],
    ["a PNG that claims 60000 x 60000 pixels", png(60000, 60000, 200)],
    ["a PNG over the pixel limit", png(4000, 3000, 500)],
    ["a PNG over 400 KB", png(100, 100, 400 * 1024 + 1)],
    ["a text string", "AAAA"], ["an object", { a: 1 }], ["null", null], ["a number", 5],
  ];
  const refused: string[] = [];
  for (const [name, data] of hostile) {
    // a fresh connection for each file, so the content checks are what refuses it and not the rate limit
    const fresh = await join(b.id, "Hostile");
    const r = (await fresh.s.timeout(4000).emitWithAck("image:add", { id: randomUUID(), data, ...geo }).catch(() => ({ ok: "timeout" }))) as { ok: unknown; error?: string };
    if (r.ok === true) throw new Error(`${name} was accepted`);
    if (r.error !== "invalid") throw new Error(`${name} was refused as ${JSON.stringify(r)}, not as invalid content`);
    refused.push(r.error);
    fresh.s.close();
    await sleep(250);
  }
  const stored = await prisma.boardImage.count({ where: { boardId: b.id } });
  if (stored !== 0) throw new Error(`${stored} hostile files were stored`);
  // a flood of adds: only the burst gets through
  const floodSocket = (await join(b.id, "Flooder")).s;
  const flood = await Promise.all(Array.from({ length: 40 }, () => floodSocket.timeout(4000).emitWithAck("image:add", { id: randomUUID(), template: "star", ...geo }).catch(() => ({ ok: false, error: "timeout" }))));
  const accepted = flood.filter((r: { ok: boolean }) => r.ok).length, limited = flood.filter((r: { error?: string }) => r.error === "rate_limited").length;
  if (accepted < 3 || accepted > 8 || limited < 25) throw new Error(`flood: ${accepted} accepted, ${limited} rate limited`);
  await prisma.boardImage.deleteMany({ where: { boardId: b.id } });
  // the per-board storage cap, with direct inserts standing in for earlier uploads
  await prisma.boardImage.create({ data: { id: randomUUID(), boardId: b.id, authorId: randomUUID(), mime: "image/png", data: Buffer.from([1]), byteSize: 2_450_000, ...geo } });
  await sleep(6000);
  const over = await add(png(100, 100, 100 * 1024));
  if (over.error !== "board_full") throw new Error(`over the storage cap: ${JSON.stringify(over)}`);
  await prisma.board.delete({ where: { id: b.id } });
  return `${hostile.length} hostile uploads refused (${[...new Set(refused)].join(", ")}), none stored; ${accepted} of 40 flood adds accepted, ${limited} rate limited; storage cap enforced`;
});

writeFileSync("logs/security/probes.json", JSON.stringify(results, null, 2));
open.forEach((s) => s.close());
server.kill("SIGTERM");
await exited(server);
await prisma.board.deleteMany({ where: { id: { in: [board.id, other.id] } } });
await prisma.$disconnect();
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} probes passed`);
process.exit(failed ? 1 : 0);
