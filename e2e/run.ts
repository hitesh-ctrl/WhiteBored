import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import {
  SOCKET, WEB, WEB_PORT, assertPortFree, enterName, exited, ink, sleep, startSocketServer, startWeb, status, stroke, waitHttp, waitUntil,
} from "./lib";

const results: { check: string; pass: boolean; detail?: string }[] = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = (await fn()) ?? undefined;
    results.push({ check: name, pass: true, detail });
    console.log(`PASS ${name}${detail ? ` (${detail})` : ""}`);
  } catch (e) {
    results.push({ check: name, pass: false, detail: String(e) });
    console.log(`FAIL ${name}: ${e}`);
  }
}
const shot = (page: import("playwright").Page, n: string) => page.screenshot({ path: `logs/evidence/${n}.png` });

await assertPortFree(4000);
await assertPortFree(WEB_PORT);
let socketProc = startSocketServer();
const web = startWeb();
await waitHttp(`${SOCKET}/health`);
await waitHttp(WEB);

const browser = await chromium.launch();
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const ctxB = await browser.newContext({ viewport: { width: 900, height: 700 } }); // different size on purpose
const A = await ctxA.newPage(), B = await ctxB.newPage();
A.on("dialog", (d) => d.accept());
const errors: string[] = [];
for (const [n, p] of [["A", A], ["B", B]] as const) p.on("pageerror", (e) => errors.push(`${n}: ${e.message}`));

let boardUrl = "";
await check("create board from home page and land on /board/<id>", async () => {
  await A.goto(WEB);
  await A.fill("#name", "E2E board");
  await A.click("text=Create board");
  await A.waitForURL(/\/board\/[0-9a-f-]{36}$/);
  boardUrl = A.url();
  return boardUrl;
});
await check("unknown board id gives 404", async () => {
  const r = await B.goto(`${WEB}/board/00000000-0000-4000-8000-000000000000`);
  if (r?.status() !== 404) throw new Error(`status ${r?.status()}`);
  const r2 = await B.goto(`${WEB}/board/not-a-uuid`);
  if (r2?.status() !== 404) throw new Error(`status ${r2?.status()}`);
});

await check("both users pick a name and join", async () => {
  await B.goto(boardUrl);
  await enterName(A, "Alice");
  await enterName(B, "Bob");
  await waitUntil(async () => (await A.locator("ul li").allInnerTexts()).some((t) => t.startsWith("Bob")), 5000, "Bob in Alice's list");
  await waitUntil(async () => (await B.locator("ul li").allInnerTexts()).some((t) => t.startsWith("Alice")), 5000, "Alice in Bob's list");
});

await check("a line grows in B while A is still drawing (progress, before release)", async () => {
  const before = await ink(B);
  await stroke(A, [0.1, 0.2], [0.6, 0.5], { release: false });
  await waitUntil(async () => (await ink(B)) > before + 200, 5000, "live ink in B");
  await shot(B, "01-live-progress-in-B");
  await A.mouse.up();
});
await check("committed stroke is visible in B", async () => {
  await sleep(300);
  const n = await ink(B);
  if (n < 200) throw new Error(`ink ${n}`);
  await shot(A, "02-A-after-stroke"); await shot(B, "03-B-after-stroke");
  return `${n} px of ink`;
});
await check("same picture on different screen sizes", async () => {
  const [a, b] = [await ink(A), await ink(B)];
  if (a !== b) throw new Error(`A ${a} vs B ${b}`);
  return `identical ink count ${a}`;
});
await check("named cursor of A appears in B at a percentage position", async () => {
  const box = (await A.locator("canvas").boundingBox())!;
  await A.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await A.mouse.move(box.x + box.width * 0.5 + 2, box.y + box.height * 0.5 + 2);
  await waitUntil(() => B.evaluate(() => [...document.querySelectorAll("[aria-hidden=true] div")].some((d) => d.textContent === "Alice")), 5000, "cursor");
  const left = await B.evaluate(() => ([...document.querySelectorAll("[aria-hidden=true] div")].find((d) => d.textContent === "Alice") as HTMLElement).style.left);
  await shot(B, "04-cursor-in-B");
  if (!left.endsWith("%")) throw new Error(`left=${left}`);
  return `left=${left}`;
});
await check("refresh keeps the drawing (persistence)", async () => {
  const before = await ink(A);
  await B.reload();
  await waitUntil(async () => (await status(B)) === "Connected", 10000, "B reconnect");
  await waitUntil(async () => (await ink(B)) === before, 5000, "same ink after refresh");
  await shot(B, "05-B-after-refresh");
});
await check("late joiner sees the full board", async () => {
  const ctxC = await browser.newContext();
  const C = await ctxC.newPage();
  await C.goto(boardUrl);
  await enterName(C, "Carol");
  const before = await ink(A);
  await waitUntil(async () => (await ink(C)) === before, 5000, "Carol sees same ink");
  await shot(C, "06-late-joiner-C");
  await ctxC.close();
});

await check("undo: B undoes own stroke only, A's stroke stays", async () => {
  const aInk = await ink(A);
  await stroke(B, [0.2, 0.7], [0.8, 0.8]);
  await waitUntil(async () => (await ink(A)) > aInk + 200, 5000, "B's stroke in A");
  await B.keyboard.press("Control+z");
  await waitUntil(async () => (await ink(A)) === aInk, 5000, "B's stroke gone in A");
  await B.keyboard.press("Control+z"); // nothing of B's left to undo
  await sleep(500);
  if ((await ink(A)) !== aInk || (await ink(B)) !== aInk) throw new Error("A's stroke was removed");
  if (!(await B.getByRole("button", { name: "Undo" }).isDisabled())) throw new Error("Undo should be disabled");
  await shot(A, "07-after-undo");
});
await check("A can undo own stroke after a refresh of the same tab", async () => {
  await A.reload();
  await waitUntil(async () => (await status(A)) === "Connected" && (await ink(A)) > 200, 10000, "A rejoined");
  await A.getByRole("button", { name: "Undo" }).click();
  await waitUntil(async () => (await ink(A)) === 0 && (await ink(B)) === 0, 5000, "stroke gone everywhere");
});

await check("clear board with confirmation removes everything for everyone", async () => {
  await stroke(A, [0.1, 0.1], [0.4, 0.4]);
  await stroke(B, [0.5, 0.5], [0.9, 0.9]);
  await waitUntil(async () => (await ink(A)) > 400 && (await ink(B)) > 400, 5000, "both strokes");
  await A.getByRole("button", { name: "Clear board" }).click();
  await waitUntil(async () => (await ink(A)) === 0 && (await ink(B)) === 0, 5000, "cleared");
  await B.reload();
  await waitUntil(async () => (await status(B)) === "Connected", 10000, "B back");
  if ((await ink(B)) !== 0) throw new Error("cleared strokes came back");
  await shot(B, "08-after-clear");
});

await check("reconnect: kill and restart the socket server", async () => {
  await stroke(A, [0.1, 0.3], [0.5, 0.3]);
  await waitUntil(async () => (await ink(B)) > 200 && (await ink(B)) === (await ink(A)), 5000, "stroke finished in both windows");
  await sleep(300); // let the save finish before the server is killed
  const saved = await ink(B);
  socketProc.kill("SIGTERM");
  const code = await exited(socketProc);
  if (code !== 0) throw new Error(`graceful shutdown exit code ${code}`);
  await waitUntil(async () => (await status(A)) === "Reconnecting..." && (await status(B)) === "Reconnecting...", 8000, "reconnecting state");
  await shot(A, "09-reconnecting");
  socketProc = startSocketServer();
  await waitHttp(`${SOCKET}/health`);
  await waitUntil(async () => (await status(A)) === "Connected" && (await status(B)) === "Connected", 20000, "both reconnected");
  if ((await ink(B)) !== saved) throw new Error("history lost after restart");
  const before = await ink(B);
  await stroke(A, [0.1, 0.6], [0.5, 0.6]);
  await waitUntil(async () => (await ink(B)) > before + 200, 5000, "live relay after restart");
  await shot(B, "10-after-reconnect");
  return `graceful exit code ${code}`;
});

await check("no uncaught page errors", async () => {
  if (errors.length) throw new Error(errors.join(" | "));
});

await browser.close();
socketProc.kill("SIGTERM"); web.kill("SIGTERM");
writeFileSync("logs/evidence/e2e-results.json", JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
