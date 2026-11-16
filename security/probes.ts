import "dotenv/config";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { io, type Socket } from "socket.io-client";
import { createPrisma } from "../src/lib/prisma";
import { SOCKET, WEB, assertPortFree, exited, sleep, startSocketServer, waitHttp } from "../e2e/lib";

const results: { probe: string; pass: boolean; detail: string }[] = [];
async function probe(name: string, fn: () => Promise<string>) {
  try { const d = await fn(); results.push({ probe: name, pass: true, detail: d }); console.log(`PASS ${name}: ${d}`); }
  catch (e) { results.push({ probe: name, pass: false, detail: String(e) }); console.log(`FAIL ${name}: ${e}`); }
}
const must = (c: unknown, msg: string) => { if (!c) throw new Error(msg); };
const health = async () => (await fetch(`${SOCKET}/health`)).status === 200;

await assertPortFree(4000);
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
const ackEvents = ["board:join", "stroke:commit", "stroke:undo", "board:clear"] as const;
const plain = ["stroke:progress", "cursor:move"] as const;

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
        if (ev === "board:clear" && s === post) continue; // a valid clear on a joined socket is legal
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

writeFileSync("logs/security/probes.json", JSON.stringify(results, null, 2));
open.forEach((s) => s.close());
server.kill("SIGTERM");
await exited(server);
await prisma.board.deleteMany({ where: { id: { in: [board.id, other.id] } } });
await prisma.$disconnect();
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} probes passed`);
process.exit(failed ? 1 : 0);
