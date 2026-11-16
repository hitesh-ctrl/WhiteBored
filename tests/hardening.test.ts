import { request } from "node:http";
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

describe("trusted proxy hops", () => {
  it("one hop: the last entry counts, so a client cannot dodge the cap by prepending values", async () => {
    const srv = await start({ maxConnectionsPerIp: 1, trustProxy: 1 });
    await srv.connect({ "x-forwarded-for": "random-1, 1.1.1.1" });
    const same = await srv.connect({ "x-forwarded-for": "random-2, 1.1.1.1" });
    expect(await dropped(same)).toBe(true);
    const other = await srv.connect({ "x-forwarded-for": "random-3, 2.2.2.2" });
    expect(await dropped(other, 800)).toBe(false);
  });
  it("two hops: the second entry from the right counts", async () => {
    const srv = await start({ maxConnectionsPerIp: 1, trustProxy: 2 });
    await srv.connect({ "x-forwarded-for": "9.9.9.9, 1.1.1.1, 10.0.0.1" });
    const same = await srv.connect({ "x-forwarded-for": "8.8.8.8, 1.1.1.1, 10.0.0.2" });
    expect(await dropped(same)).toBe(true);
  });
  it("addresses in one IPv6 /64 share one allowance", async () => {
    const srv = await start({ maxConnectionsPerIp: 1, trustProxy: 1 });
    await srv.connect({ "x-forwarded-for": "2001:db8:1:2:3:4:5:6" });
    const same = await srv.connect({ "x-forwarded-for": "2001:db8:1:2:ffff:0:0:1" });
    expect(await dropped(same)).toBe(true);
  });
});

/** A raw polling request with the Host and Origin headers chosen by the test. */
const poll = (url: string, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    const u = new URL(url);
    const req = request({ host: u.hostname, port: u.port, path: "/socket.io/?EIO=4&transport=polling", headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject);
    req.end();
  });

describe("fixed-origin mode (a separate web address)", () => {
  it("accepts only the configured origin, over polling and over websocket, and still accepts non-browser clients", async () => {
    const srv = await start();
    expect(await poll(srv.url, { Origin: "http://localhost:3000" })).toBe(200);
    expect(await poll(srv.url, { Origin: "http://evil.example" })).toBe(403);
    expect(await poll(srv.url, { Origin: "http://localhost:3000.evil.example" })).toBe(403);
    expect(await poll(srv.url, {})).toBe(200);
    expect((await srv.connect({ origin: "http://localhost:3000" })).connected).toBe(true);
    await expect(srv.connect({ origin: "http://evil.example" })).rejects.toBeTruthy();
  });
});

describe("same-origin mode (one address serves the pages and the sockets)", () => {
  it("compares the whole host: a parent domain or a part of the host is not the same origin", async () => {
    const srv = await start({ corsOrigin: "same-origin" });
    const host = "app.example.com";
    expect(await poll(srv.url, { Host: host, Origin: `https://${host}` })).toBe(200);
    expect(await poll(srv.url, { Host: host, Origin: "https://example.com" })).toBe(403);
    expect(await poll(srv.url, { Host: host, Origin: "https://ample.com" })).toBe(403);
    expect(await poll(srv.url, { Host: host, Origin: "https://app.example.com.evil.net" })).toBe(403);
    expect(await poll(srv.url, { Host: host, Origin: "https://xapp.example.com" })).toBe(403);
  });
  it("accepts a page from the host it is talking to, and no Origin header at all", async () => {
    const srv = await start({ corsOrigin: "same-origin" });
    const host = new URL(srv.url).host;
    const ok = await srv.connect({ origin: `https://${host}` });
    expect(ok.connected).toBe(true);
    expect((await srv.connect()).connected).toBe(true);
  });
  it("refuses a page from another host, a null origin and a look-alike host", async () => {
    const srv = await start({ corsOrigin: "same-origin" });
    const host = new URL(srv.url).host;
    for (const origin of ["http://evil.example", "null", `http://${host}.evil.example`, `http://x${host}`]) {
      await expect(srv.connect({ origin })).rejects.toBeTruthy();
    }
  });
  it("answers a polling request from the same host and refuses one from another host", async () => {
    const srv = await start({ corsOrigin: "same-origin" });
    const host = new URL(srv.url).host;
    const url = `${srv.url}/socket.io/?EIO=4&transport=polling`;
    expect((await fetch(url, { headers: { Origin: `http://${host}` } })).status).toBe(200);
    expect((await fetch(url, { headers: { Origin: "http://evil.example" } })).status).toBe(403);
  });
  it("does not add open CORS headers", async () => {
    const srv = await start({ corsOrigin: "same-origin" });
    const res = await fetch(`${srv.url}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: `http://${new URL(srv.url).host}` } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("plain http routes", () => {
  it("serves /health and /metrics with a query string, and 404 for anything else", async () => {
    const srv = await start();
    expect((await fetch(`${srv.url}/health?x=1`)).status).toBe(200);
    expect((await fetch(`${srv.url}/metrics?x=1`)).status).toBe(200);
    expect((await fetch(`${srv.url}/nothing`)).status).toBe(404);
  });
  it("protects /metrics with a bearer token when one is configured, and leaves /health open", async () => {
    const srv = await start({ metricsToken: "s3cret-token-value" });
    expect((await fetch(`${srv.url}/metrics`)).status).toBe(401);
    expect((await fetch(`${srv.url}/metrics`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${srv.url}/metrics`, { headers: { authorization: "Bearer s3cret-token-value" } })).status).toBe(200);
    expect((await fetch(`${srv.url}/health`)).status).toBe(200);
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
