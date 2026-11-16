import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { SOCKET, SOCKET_PORT, WEB, WEB_PORT, assertPortFree, enterName, sleep, startSocketServer, startWeb, waitHttp, waitUntil } from "../e2e/lib";

// Complete, working payloads that fit the 30 character name limit. Any execution opens an alert dialog.
const SHORT = "<img src=x onerror=alert(1)>";
const nameA = "<svg onload=alert(2)>";
const nameB = "<script>alert(3)</script>";
const results: { check: string; pass: boolean; detail: string }[] = [];
const rec = (check: string, pass: boolean, detail: string) => { results.push({ check, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} ${check}: ${detail}`); };

await assertPortFree(SOCKET_PORT); await assertPortFree(WEB_PORT);
const socket = startSocketServer(); const web = startWeb();
await waitHttp(`${SOCKET}/health`); await waitHttp(WEB);

const browser = await chromium.launch();
const A = await (await browser.newContext()).newPage();
const B = await (await browser.newContext()).newPage();
const dialogs: string[] = [];
for (const p of [A, B]) p.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });

await A.goto(WEB);
await A.fill("#name", SHORT);
await A.click("text=Create board");
await A.waitForURL(/\/board\/[0-9a-f-]{36}$/);
const url = A.url();
await B.goto(url);
await enterName(A, nameA);
await enterName(B, nameB);

await waitUntil(async () => (await A.locator("ul li").allInnerTexts()).some((t) => t.includes(nameB)), 6000, "B's raw name in A's list");
const box = (await B.locator("canvas").boundingBox())!;
await B.mouse.move(box.x + 50, box.y + 50); await B.mouse.move(box.x + 80, box.y + 80);
await waitUntil(() => A.evaluate((n) => [...document.querySelectorAll("[aria-hidden=true] div")].some((d) => d.textContent === n), nameB), 6000, "B's cursor label in A");
await sleep(500);

for (const [label, page] of [["A", A], ["B", B]] as const) {
  const r = await page.evaluate(() => ({
    xss: (window as unknown as { __xss?: unknown }).__xss ?? null,
    imgs: document.querySelectorAll("img").length,
    svgOnload: document.querySelectorAll("svg[onload]").length,
    scripts: [...document.querySelectorAll("script")].filter((s) => (s.textContent ?? "").includes("__xss")).length,
    h1: document.querySelector("h1")?.textContent,
    h1html: document.querySelector("h1")?.innerHTML,
  }));
  rec(`${label}: no script ran and no injected elements exist`, r.xss === null && r.imgs === 0 && r.svgOnload === 0 && r.scripts === 0, JSON.stringify({ xss: r.xss, imgs: r.imgs, svgOnload: r.svgOnload, scripts: r.scripts }));
  rec(`${label}: board name is shown as literal text`, r.h1 === SHORT && !!r.h1html && r.h1html.includes("&lt;img"), `text=${r.h1} html=${r.h1html}`);
}
const listA = await A.locator("ul li").allInnerTexts();
const cursor = await A.evaluate(() => [...document.querySelectorAll("[aria-hidden=true] div")].map((d) => ({ text: d.textContent, html: d.innerHTML })));
rec("user names render as text in the list", listA.some((t) => t.includes(nameB)) && listA.some((t) => t.includes(nameA)), JSON.stringify(listA));
rec("cursor label is a text node", cursor.some((c) => c.text === nameB && c.html.includes("&lt;script&gt;alert(3)&lt;/script&gt;")), JSON.stringify(cursor));
rec("no alert dialogs fired", dialogs.length === 0, `${dialogs.length} dialogs`);
await A.screenshot({ path: "logs/evidence/11-xss-names-as-text.png" });

await browser.close(); socket.kill("SIGTERM"); web.kill("SIGTERM");
writeFileSync("logs/security/xss.json", JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass).length;
console.log(`${results.length - failed}/${results.length} xss checks passed`);
process.exit(failed ? 1 : 0);
