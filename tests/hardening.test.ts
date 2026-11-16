import { afterAll, describe, expect, it } from "vitest";
import { createBoard, emitAck, joinAs, sleep, startTestServer, stroke, type TestServer } from "./helpers";

const open: TestServer[] = [];
const start = async (o = {}) => { const s = await startTestServer(o); open.push(s); return s; };
afterAll(async () => { for (const s of open) await s.close(); });

const dropped = (s: import("socket.io-client").Socket, ms = 1500) =>
  new Promise<boolean>((res) => { s.once("disconnect", () => res(true)); setTimeout(() => res(false), ms); });

describe("connections per client address", () => {
  it("disconnects the connection over the limit and keeps the others", async () => {
    const srv = await start({ maxConnectionsPerIp: 3 });
    const first = await Promise.all([srv.connect(), srv.connect(), srv.connect()]);
    const extra = await srv.connect();
    expect(await dropped(extra)).toBe(true);
    expect(first.every((s) => s.connected)).toBe(true);
  });

  it("frees a slot when a connection closes", async () => {
    const srv = await start({ maxConnectionsPerIp: 2 });
    const a = await srv.connect();
    await srv.connect();
    a.close();
    await sleep(300);
    const c = await srv.connect();
    expect(await dropped(c, 800)).toBe(false);
    expect(c.connected).toBe(true);
  });

  it("ignores X-Forwarded-For unless the proxy is trusted", async () => {
    const srv = await start({ maxConnectionsPerIp: 1 });
    await srv.connect({ "x-forwarded-for": "1.1.1.1" });
    const spoofed = await srv.connect({ "x-forwarded-for": "2.2.2.2" });
    expect(await dropped(spoofed)).toBe(true);
  });

  it("counts each forwarded address separately when the proxy is trusted", async () => {
    const srv = await start({ maxConnectionsPerIp: 1, trustProxy: true });
    const a = await srv.connect({ "x-forwarded-for": "1.1.1.1" });
    const b = await srv.connect({ "x-forwarded-for": "2.2.2.2" });
    const again = await srv.connect({ "x-forwarded-for": "1.1.1.1" });
    expect(await dropped(again)).toBe(true);
    expect(a.connected && b.connected).toBe(true);
  });
});

describe("metrics", () => {
  const read = async (url: string) => {
    const text = await (await fetch(`${url}/metrics`)).text();
    const num = (name: string) => Number(new RegExp(`^${name} (\\d+)$`, "m").exec(text)?.[1] ?? NaN);
    return { text, num };
  };

  it("serves plain-text counters that move with activity", async () => {
    const srv = await start();
    const before = await read(srv.url);
    expect(before.text).toContain("whiteboard_connections_current");
    const board = await createBoard(srv.prisma);
    const a = await joinAs(srv, board.id, "Ann");
    await emitAck(a.socket, "stroke:commit", stroke());
    const after = await read(srv.url);
    expect(after.num("whiteboard_connections_current")).toBe(before.num("whiteboard_connections_current") + 1);
    expect(after.num("whiteboard_joins_total")).toBe(before.num("whiteboard_joins_total") + 1);
    expect(after.num("whiteboard_commits_total")).toBe(before.num("whiteboard_commits_total") + 1);
  });

  it("is plain text and contains no board ids, names or keys", async () => {
    const srv = await start();
    const board = await createBoard(srv.prisma, "Secret name");
    await joinAs(srv, board.id, "Hidden person");
    const res = await fetch(`${srv.url}/metrics`);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    const text = await res.text();
    expect(text).not.toContain(board.id);
    expect(text).not.toContain("Secret name");
    expect(text).not.toContain("Hidden person");
  });
});
