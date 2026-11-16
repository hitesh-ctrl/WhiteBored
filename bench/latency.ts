import "dotenv/config";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { io } from "socket.io-client";
import { createPrisma } from "../src/lib/prisma";
import { assertPortFree, exited, sleep, startSocketServer, waitHttp } from "../e2e/lib";

// The server limits each socket (40 progress/s, 5 commits/s), so samples are paced below those
// rates. Hitting the limit would measure the limiter, not the relay.
const N_PROGRESS = 1000, PROGRESS_GAP_MS = 30; // about 33 per second
const N_COMMIT = 300, COMMIT_GAP_MS = 250; // 4 per second
const WARMUP = 20;
await assertPortFree(4000);
const prisma = createPrisma();
const board = await prisma.board.create({ data: { name: "bench" } });
const server = startSocketServer();
await waitHttp("http://localhost:4000/health");

const connect = async (name: string) => {
  const s = io("http://localhost:4000", { transports: ["websocket"], forceNew: true });
  await new Promise<void>((r) => s.once("connect", () => r()));
  const ack = await s.emitWithAck("board:join", { boardId: board.id, clientId: randomUUID(), name });
  if (!ack.ok) throw new Error("join failed");
  return s;
};
const A = await connect("A"), B = await connect("B");
process.on("exit", () => server.kill("SIGTERM"));

const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
const summarize = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { samples: s.length, p50_ms: +pct(s, 50).toFixed(3), p95_ms: +pct(s, 95).toFixed(3), max_ms: +s[s.length - 1].toFixed(3) };
};
const stroke = () => ({ id: randomUUID(), color: "#112233", width: 4, points: Array.from({ length: 20 }, (_, i) => [i * 10, i * 5]) });

// A sends progress, time until B receives it (no database involved)
const relay: number[] = [];
for (let i = 0; i < N_PROGRESS + WARMUP; i++) {
  const s = stroke();
  const got = new Promise<void>((r) => B.once("stroke:progress", () => r()));
  const t0 = performance.now();
  A.emit("stroke:progress", s);
  await got;
  if (i >= WARMUP) relay.push(performance.now() - t0);
  await sleep(PROGRESS_GAP_MS);
}
// A commits, time until the ack (includes the database transaction)
const ackT: number[] = [], commitRelay: number[] = [];
for (let i = 0; i < N_COMMIT + WARMUP; i++) {
  const s = stroke();
  const got = new Promise<number>((r) => B.once("stroke:commit", () => r(performance.now())));
  const t0 = performance.now();
  const ack = await A.emitWithAck("stroke:commit", s);
  const tAck = performance.now();
  const tRelay = await got;
  if (!ack.ok) throw new Error(`commit failed ${JSON.stringify(ack)}`);
  if (i >= WARMUP) { ackT.push(tAck - t0); commitRelay.push(tRelay - t0); }
  await sleep(COMMIT_GAP_MS);
}

const result = {
  note: "Loopback on one machine, one server process, one local Postgres. Samples are paced under the per-socket rate limits. Measures server cost only, not internet latency.",
  node: process.version,
  progress_relay_A_to_B: summarize(relay),
  commit_ack_roundtrip: summarize(ackT),
  commit_relay_A_to_B: summarize(commitRelay),
};
console.log(JSON.stringify(result, null, 2));
writeFileSync("logs/evidence/benchmark.json", JSON.stringify(result, null, 2));

A.close(); B.close();
server.kill("SIGTERM");
await exited(server);
await prisma.board.delete({ where: { id: board.id } });
await prisma.$disconnect();
