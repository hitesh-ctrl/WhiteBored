// Run the whole app behind ONE address and port: the pages, the socket server and a small router.
//   npm run serve          (needs a production build made with an empty NEXT_PUBLIC_SOCKET_URL)
// Used by the container image for hosts that give a single web address (Render and similar).
import http from "node:http";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";

const PORT = Number(process.env.PORT ?? 3500);
const WEB_PORT = Number(process.env.INTERNAL_WEB_PORT ?? 3401);
const SOCKET_PORT = Number(process.env.INTERNAL_SOCKET_PORT ?? 4401);

const env = {
  ...process.env,
  SOCKET_PORT: String(SOCKET_PORT),
  CORS_ORIGIN: "same-origin", // pages and sockets share one host, so only that host may connect
  // every request reaches the socket server through the router, so a per-address cap would count everybody as one
  MAX_CONNECTIONS_PER_IP: process.env.MAX_CONNECTIONS_PER_IP ?? "500",
};

if (process.env.RUN_MIGRATIONS === "true") {
  console.log("Applying database migrations ...");
  const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
  const m = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
    env: { ...env, DATABASE_URL: url },
    stdio: "inherit",
  });
  if (m.status !== 0) {
    console.error("Migration failed; not starting.");
    process.exit(1);
  }
}

const children = [
  spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], { env, stdio: "inherit" }),
  spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(WEB_PORT)], { env, stdio: "inherit" }),
];

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  console.log("Shutting down ...");
  for (const c of children) c.kill("SIGTERM");
  server.close();
  setTimeout(() => process.exit(code), 4000).unref();
  Promise.all(children.map((c) => new Promise((r) => (c.exitCode !== null ? r() : c.once("exit", r))))).then(() => process.exit(code));
};
for (const c of children) c.on("exit", (code) => { if (!stopping) { console.error(`A part of the app stopped (exit ${code}).`); stop(1); } });
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

const isSocketPath = (url = "") => url.startsWith("/socket.io/");
const reachable = (port) => new Promise((resolve) => {
  const s = net.connect(port, "127.0.0.1", () => { s.destroy(); resolve(true); });
  s.on("error", () => resolve(false));
});

const server = http.createServer(async (req, res) => {
  if (req.url === "/healthz") {
    const ok = (await reachable(WEB_PORT)) && (await reachable(SOCKET_PORT));
    res.writeHead(ok ? 200 : 503, { "content-type": "text/plain" }).end(ok ? "ok" : "starting");
    return;
  }
  const forwarded = [req.headers["x-forwarded-for"], req.socket.remoteAddress].filter(Boolean).join(", ");
  const up = http.request(
    { host: "127.0.0.1", port: isSocketPath(req.url) ? SOCKET_PORT : WEB_PORT, method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-for": forwarded } },
    (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); },
  );
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
});

// WebSocket upgrades: only the socket server speaks them, so the router just joins the two connections
server.on("upgrade", (req, socket, head) => {
  if (!isSocketPath(req.url)) return void socket.destroy();
  const up = net.connect(SOCKET_PORT, "127.0.0.1", () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    up.write(`${raw}\r\n`);
    up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
  socket.on("close", () => up.destroy());
});

server.listen(PORT, "0.0.0.0", () => console.log(`Whiteboard is listening on :${PORT}`));
