import "dotenv/config";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { io } from "socket.io-client";
import { createPrisma } from "../src/lib/prisma";
import { assertPortFree, exited, startSocketServer, waitHttp } from "../e2e/lib";

const N = 2000;
const WARMUP = 100;
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

const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
const summarize = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { samples: s.length, p50_ms: +pct(s, 50).toFixed(3), p95_ms: +pct(s, 95).toFixed(3), max_ms: +s[s.length - 1].toFixed(3) };
};
const stroke = () => ({ id: randomUUID(), color: "#112233", width: 4, points: Array.from({ length: 20 }, (_, i) => [i * 10, i * 5]) });

// A sends progress, time until B receives it (no database involved)
const relay: number[] = [];
for (let i = 0; i < N + WARMUP; i++) {
  const s = stroke();
  const got = new Promise<void>((r) => B.once("stroke:progress", () => r()));
  const t0 = performance.now();
  A.emit("stroke:progress", s);
  await got;
  if (i >= WARMUP) relay.push(performance.now() - t0);
}
// A commits, time until the ack (includes the database transaction)
const ackT: number[] = [], commitRelay: number[] = [];
for (let i = 0; i < N + WARMUP; i++) {
  const s = stroke();
  const got = new Promise<number>((r) => B.once("stroke:commit", () => r(performance.now())));
  const t0 = performance.now();
  const ack = await A.emitWithAck("stroke:commit", s);
  const tAck = performance.now();
  const tRelay = await got;
  if (!ack.ok) throw new Error(`commit failed ${JSON.stringify(ack)}`);
  if (i >= WARMUP) { ackT.push(tAck - t0); commitRelay.push(tRelay - t0); }
}

const result = {
  note: "Loopback on one machine, one server process, one local Postgres. Measures server cost only, not internet latency.",
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
