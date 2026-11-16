import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";

// logs/ is not in git, so a fresh checkout (for example in CI) does not have it
mkdirSync("logs/evidence", { recursive: true });
mkdirSync("logs/security", { recursive: true });
import type { Page } from "playwright";

export const WEB_PORT = 3100;
export const WEB = `http://localhost:${WEB_PORT}`;
export const SOCKET_PORT = 4100;
export const SOCKET = `http://localhost:${SOCKET_PORT}`;

export function startProc(label: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  const log = createWriteStream(`logs/e2e-${label}.log`, { flags: "a" });
  const p = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout?.pipe(log);
  p.stderr?.pipe(log);
  return p;
}
export const startSocketServer = () => startProc("socket", ["--import", "tsx", "src/server/index.ts"], { CORS_ORIGIN: WEB, SOCKET_PORT: String(SOCKET_PORT), MAX_CONNECTIONS_PER_IP: "500" });
export const startWeb = () => startProc("web", ["node_modules/next/dist/bin/next", "start", "-p", String(WEB_PORT)]);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(fn: () => Promise<boolean> | boolean, ms = 8000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return; } catch { /* retry */ }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function waitHttp(url: string, ms = 20000) {
  await waitUntil(async () => (await fetch(url)).status < 500, ms, url);
}

export function exited(p: ChildProcess): Promise<number | null> {
  return new Promise((r) => (p.exitCode !== null ? r(p.exitCode) : p.once("exit", (code) => r(code))));
}

/** Number of non-transparent pixels on the drawing canvas. */
export const ink = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector("canvas")!;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });

export async function stroke(page: Page, from: [number, number], to: [number, number], opts: { release?: boolean } = {}) {
  const box = (await page.locator("canvas").boundingBox())!;
  const at = (f: [number, number]) => [box.x + box.width * f[0], box.y + box.height * f[1]] as const;
  const [x0, y0] = at(from), [x1, y1] = at(to);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 20, y0 + ((y1 - y0) * i) / 20);
  if (opts.release !== false) await page.mouse.up();
}

export async function enterName(page: Page, name: string) {
  await page.fill("#who", name);
  await page.click("text=Join board");
  await waitUntil(async () => (await page.locator("header [role=status]").innerText()) === "Connected", 10000, `${name} connected`);
}
export const status = (page: Page) => page.locator("header [role=status]").innerText();

/** Refuse to run against a port that something else already uses. */
export async function assertPortFree(port: number) {
  const net = await import("node:net");
  await new Promise<void>((res, rej) => {
    const s = net.createServer();
    s.once("error", () => rej(new Error(`port ${port} is already in use`)));
    s.listen(port, () => s.close(() => res()));
  });
}
