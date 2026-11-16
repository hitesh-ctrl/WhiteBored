import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { PrismaPg } from "@prisma/adapter-pg";
import { io as ioc, type Socket } from "socket.io-client";
import { PrismaClient } from "../src/generated/prisma/client";
import { createWhiteboardServer } from "../src/server/app";

export const ORIGIN = "http://localhost:3000";

export function makePrisma() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

export type TestServer = {
  url: string;
  prisma: PrismaClient;
  close(): Promise<void>;
  sockets: Socket[];
  connect(): Promise<Socket>;
};

export async function startTestServer(): Promise<TestServer> {
  const prisma = makePrisma();
  const { httpServer, io } = createWhiteboardServer({ prisma, corsOrigin: ORIGIN });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = (httpServer.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const sockets: Socket[] = [];
  return {
    url,
    prisma,
    sockets,
    async connect() {
      const s = ioc(url, { transports: ["websocket"], forceNew: true, reconnection: false });
      sockets.push(s);
      await new Promise<void>((res, rej) => {
        s.once("connect", () => res());
        s.once("connect_error", rej);
      });
      return s;
    },
    async close() {
      sockets.forEach((s) => s.close());
      await io.close();
      await prisma.$disconnect();
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Emit with ack, failing after 3 s (this is how a missing handler shows up). */
export function emitAck<T = any>(s: Socket, event: string, ...args: unknown[]): Promise<T> {
  return s.timeout(3000).emitWithAck(event, ...args) as Promise<T>;
}

export function waitFor<T = any>(s: Socket, event: string, ms = 3000): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timed out waiting for ${event}`)), ms);
    s.once(event, (data: T) => {
      clearTimeout(t);
      res(data);
    });
  });
}

/** Records every event of the given names so tests can assert nothing arrived. */
export function record(s: Socket, events: string[]) {
  const got: { event: string; data: unknown }[] = [];
  for (const e of events) s.on(e, (data: unknown) => got.push({ event: e, data }));
  return got;
}

export const uuid = () => randomUUID();

export function stroke(over: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    color: "#112233",
    width: 4,
    points: [
      [10, 10],
      [20.5, 30.5],
    ],
    ...over,
  };
}

export async function createBoard(prisma: PrismaClient, name = "test board") {
  return prisma.board.create({ data: { name } });
}

export async function joinAs(srv: TestServer, boardId: string, name: string, clientId = uuid()) {
  const socket = await srv.connect();
  const ack = await emitAck(socket, "board:join", { boardId, clientId, name });
  return { socket, ack, clientId };
}
