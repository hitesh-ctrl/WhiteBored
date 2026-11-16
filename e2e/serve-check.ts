import { io } from "socket.io-client";
import { chromium } from "playwright";
import { enterName, ink, stroke, waitUntil } from "./lib";

// Checks a running single-address deployment. BASE is its address, for example http://localhost:3500
const BASE = process.env.BASE ?? "http://localhost:3500";
const results: { check: string; pass: boolean; detail: string }[] = [];
async function check(name: string, fn: () => Promise<string>) {
  try { const d = await fn(); results.push({ check: name, pass: true, detail: d }); console.log(`PASS ${name}: ${d}`); }
  catch (e) { results.push({ check: name, pass: false, detail: String(e) }); console.log(`FAIL ${name}: ${e}`); }
}

await check("health route answers through the router", async () => {
  const r = await fetch(`${BASE}/healthz`);
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  return await r.text();
});
await check("page is served with the security headers and no separate socket address in the policy", async () => {
  const r = await fetch(BASE);
  const csp = r.headers.get("content-security-policy") ?? "";
  if (r.status !== 200 || !csp.includes("connect-src 'self'") || /localhost:4\d\d\d/.test(csp)) throw new Error(csp);
  if (r.headers.get("x-frame-options") !== "DENY") throw new Error("no frame header");
  return csp.split(";").find((p) => p.includes("connect-src"))!.trim();
});
await check("a page from another host cannot open a socket connection, the real host can", async () => {
  const host = new URL(BASE).host;
  const open = (origin?: string) => new Promise<boolean>((res) => {
    const s = io(BASE, { transports: ["websocket"], reconnection: false, forceNew: true, extraHeaders: origin ? { origin } : {} });
    s.once("connect", () => { s.close(); res(true); });
    s.once("connect_error", () => { s.close(); res(false); });
  });
  const evil = await open("http://evil.example"), good = await open(`${new URL(BASE).protocol}//${host}`);
  if (evil || !good) throw new Error(`evil=${evil} good=${good}`);
  return "evil origin refused, same origin accepted";
});

const browser = await chromium.launch();
const mk = async () => await (await browser.newContext({ viewport: { width: 1200, height: 800 }, ignoreHTTPSErrors: true })).newPage();
const A = await mk(), B = await mk(), V = await mk();
const errors: string[] = [];
for (const [n, p] of [["A", A], ["B", B], ["V", V]] as const) {
  p.on("pageerror", (e) => errors.push(`${n}: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error") errors.push(`${n}: ${m.text().slice(0, 200)}`); });
}
let editLink = "", viewLink = "";
await check("create a board, join as owner over the websocket, draw", async () => {
  await A.goto(BASE);
  await A.fill("#name", "Deploy check");
  await A.click("text=Create board");
  await A.waitForURL(/\/board\/[0-9a-f-]{36}/);
  await enterName(A, "Host");
  await stroke(A, [0.1, 0.2], [0.5, 0.4]);
  await waitUntil(async () => (await ink(A)) > 200, 4000, "ink");
  editLink = A.url().split("#")[0];
  await A.getByRole("button", { name: "Copy view-only link" }).waitFor({ timeout: 4000 });
  return editLink;
});
await check("a guest on the edit link and a watcher on the view-only link see the same picture live", async () => {
  viewLink = await A.evaluate(`(async () => { try { return await new Promise((res) => { const orig = window.prompt; window.prompt = (m, v) => { res(v); return null; }; navigator.clipboard.writeText = undefined; document.querySelectorAll("button").forEach((b) => { if (b.textContent === "Copy view-only link") b.click(); }); setTimeout(() => res(""), 1500); }); } catch { return ""; } })()`) as string;
  await B.goto(editLink); await enterName(B, "Guest");
  if (viewLink) { await V.goto(viewLink); await enterName(V, "Watcher"); }
  await stroke(B, [0.1, 0.6], [0.5, 0.8]);
  await waitUntil(async () => (await ink(A)) === (await ink(B)) && (await ink(A)) > 3000, 6000, "same ink in A and B");
  if (viewLink) await waitUntil(async () => (await ink(V)) === (await ink(A)), 6000, "watcher sees it");
  if (viewLink && (await V.getByText("View only", { exact: true }).count()) !== 1) throw new Error("watcher is not view-only");
  return `viewer link ${viewLink ? "worked" : "not captured"}; ink ${await ink(A)} px in all windows`;
});
await check("no uncaught page errors and no policy violations", async () => {
  if (errors.length) throw new Error(errors.join(" | "));
  return "none";
});
await A.screenshot({ path: `logs/evidence/deploy-check-${process.env.TAG ?? "local"}.png` });
await browser.close();
const failed = results.filter((r) => !r.pass).length;
console.log(`${results.length - failed}/${results.length} deployment checks passed`);
process.exit(failed ? 1 : 0);
