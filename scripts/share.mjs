// Serve the whiteboard on this computer's network address so people on the same Wi-Fi or network
// can open it:  npm run share
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";

const WEB_PORT = Number(process.env.SHARE_WEB_PORT ?? 3400);
const SOCKET_PORT = Number(process.env.SHARE_SOCKET_PORT ?? 4400);

function lanAddress() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254.")) found.push({ name, address: i.address });
    }
  }
  return (found.find((f) => f.name === "en0") ?? found[0])?.address;
}

const free = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, () => s.close(() => resolve(true)));
  });

const ip = process.env.SHARE_HOST ?? lanAddress();
if (!ip) {
  console.error("No network address found. Connect to a network first, or set SHARE_HOST to the address people should use.");
  process.exit(1);
}
for (const p of [WEB_PORT, SOCKET_PORT]) {
  if (!(await free(p))) {
    console.error(`Port ${p} is already in use. Stop whatever uses it or set SHARE_WEB_PORT / SHARE_SOCKET_PORT.`);
    process.exit(1);
  }
}

const webUrl = `http://${ip}:${WEB_PORT}`;
const socketUrl = `http://${ip}:${SOCKET_PORT}`;
// the browser learns the socket address at build time, so build for exactly these addresses
const env = { ...process.env, NEXT_PUBLIC_SOCKET_URL: socketUrl, NEXT_DIST_DIR: ".next-share", CORS_ORIGIN: webUrl, SOCKET_PORT: String(SOCKET_PORT) };

console.log(`Building for ${webUrl} ...`);
const build = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], { env, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const children = [
  spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], { env, stdio: "inherit" }),
  spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", String(WEB_PORT)], { env, stdio: "inherit" }),
];
const stop = () => { for (const c of children) c.kill("SIGTERM"); setTimeout(() => process.exit(0), 1500); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const c of children) c.on("exit", (code) => { if (code) { console.error("A server stopped; shutting down."); stop(); } });

setTimeout(() => {
  console.log(`\n  Open this yourself (not localhost, so the links you copy work for others):\n    ${webUrl}\n`);
  console.log("  Then send people the board link from the \"Copy link\" button, or the view-only link.");
  console.log("  They must be on the same network and may need to allow the connection in a firewall prompt.");
  console.log("  Press Ctrl+C to stop.\n");
}, 4000);
