import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Page } from "playwright";
import { createPrisma } from "../src/lib/prisma";
import {
  SOCKET, SOCKET_PORT, WEB, WEB_PORT, assertPortFree, enterName, ink, sleep, startSocketServer, startWeb, stroke,
  waitHttp, waitUntil,
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
const shot = (page: Page, n: string) => page.screenshot({ path: `logs/evidence/${n}.png` });
const tool = (page: Page, name: string) => page.getByRole("button", { name, exact: true, includeHidden: false });
const pick = (page: Page, name: string) => page.getByRole("group", { name: "Tools" }).getByRole("button", { name, exact: true }).click();
const alphaAt = (page: Page, x: number, y: number) =>
  page.evaluate(([px, py]) => document.querySelector("canvas")!.getContext("2d")!.getImageData(px, py, 1, 1).data[3], [x, y]);
const zoomLabel = (page: Page) => page.getByRole("button", { name: "Reset zoom" }).innerText();
const inkBoth = async (a: Page, b: Page) => [await ink(a), await ink(b)];
const same = (a: Page, b: Page, what: string) => waitUntil(async () => { const [x, y] = await inkBoth(a, b); return x === y; }, 6000, what);

await assertPortFree(SOCKET_PORT);
await assertPortFree(WEB_PORT);
const prisma = createPrisma();
const socket = startSocketServer();
const web = startWeb();
await waitHttp(`${SOCKET}/health`);
await waitHttp(WEB);

const browser = await chromium.launch();
const mk = async (w = 1280, h = 800) => { const c = await browser.newContext({ viewport: { width: w, height: h } }); return { c, p: await c.newPage() }; };
const { p: A } = await mk();
const { p: B } = await mk(1000, 700);
A.on("dialog", (d) => void d.accept());
const errors: string[] = [];
for (const [n, p] of [["A", A], ["B", B]] as const) {
  p.on("pageerror", (e) => errors.push(`${n}: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && /Content Security Policy/i.test(m.text())) errors.push(`${n} CSP: ${m.text()}`); });
}

let boardId = "", boardUrl = "";
await check("creator becomes owner: fragment is removed, key kept, Rename and Clear are shown", async () => {
  await A.goto(WEB);
  await A.fill("#name", "Feature board");
  await A.click("text=Create board");
  await A.waitForURL(/\/board\/[0-9a-f-]{36}/);
  await enterName(A, "Alice");
  boardUrl = A.url().split("#")[0];
  boardId = boardUrl.split("/").pop()!;
  const hash = await A.evaluate(() => location.hash);
  const keys = await A.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("whiteboard:owner:")));
  if (hash !== "") throw new Error(`hash still in address bar: ${hash}`);
  if (keys.length !== 1) throw new Error(`owner key not stored: ${keys}`);
  await tool(A, "Rename").waitFor({ timeout: 4000 });
  await tool(A, "Clear board").waitFor({ timeout: 4000 });
  const row = await prisma.board.findUniqueOrThrow({ where: { id: boardId } });
  if (!row.ownerHash || row.ownerHash.length !== 64) throw new Error("owner hash not stored");
  const stored = await A.evaluate((k) => localStorage.getItem(k), keys[0]);
  if (stored && row.ownerHash === stored) throw new Error("the key itself was stored, not its hash");
  return "owner key stays in the browser, only a 64 char hash is stored";
});
await check("another person with the plain link is an editor: no Rename, no Clear, can share a view link", async () => {
  await B.goto(boardUrl);
  await enterName(B, "Bob");
  if ((await tool(B, "Rename").count()) + (await tool(B, "Clear board").count()) !== 0) throw new Error("editor sees owner controls");
  await tool(B, "Copy view-only link").waitFor({ timeout: 4000 });
  await waitUntil(async () => (await A.locator("ul li").allInnerTexts()).some((t) => t.startsWith("Bob")), 5000, "Bob listed");
});
await check("people are shown with their own colour", async () => {
  const dots = await A.locator("ul li span[aria-hidden=true]").evaluateAll((els) => els.map((e) => (e as HTMLElement).style.background));
  // the browser reports the hsl() value as rgb(), so only check that it is a colour
  if (dots.length < 2 || !dots.every((d) => /^(rgb|hsl)\(/.test(d))) throw new Error(JSON.stringify(dots));
  if (new Set(dots).size !== dots.length) throw new Error("two people share a colour");
  return dots.join(" / ");
});

let inkOne = 0, inkTwo = 0;
await check("pen strokes appear for both", async () => {
  await stroke(A, [0.1, 0.15], [0.4, 0.15]);
  await same(A, B, "first stroke in both");
  inkOne = await ink(A);
  await stroke(A, [0.1, 0.35], [0.4, 0.35]);
  await waitUntil(async () => (await ink(B)) > inkOne + 100, 5000, "second stroke");
  await same(A, B, "second stroke in both");
  inkTwo = await ink(A);
});
await check("eraser removes only the stroke it touches, for everyone", async () => {
  await pick(A, "Eraser");
  await stroke(A, [0.1, 0.35], [0.4, 0.35]);
  await waitUntil(async () => (await ink(A)) === inkOne && (await ink(B)) === inkOne, 6000, "second stroke erased in A and B");
  if ((await prisma.stroke.count({ where: { boardId } })) !== 1) throw new Error("database does not have exactly 1 stroke");
  await shot(A, "f01-after-erase");
});
await check("redo brings the erased stroke back for everyone, and Redo is disabled afterwards", async () => {
  if (await A.getByRole("button", { name: "Redo" }).isDisabled()) throw new Error("Redo should be enabled after an erase");
  await A.keyboard.press("Control+Shift+z");
  await waitUntil(async () => (await ink(A)) === inkTwo && (await ink(B)) === inkTwo, 6000, "stroke back in A and B");
  await waitUntil(() => A.getByRole("button", { name: "Redo" }).isDisabled(), 3000, "Redo disabled");
  if ((await prisma.stroke.count({ where: { boardId } })) !== 2) throw new Error("database does not have 2 strokes");
});
await check("a new stroke clears the redo list", async () => {
  await pick(A, "Eraser");
  await stroke(A, [0.1, 0.35], [0.4, 0.35]);
  await waitUntil(() => A.getByRole("button", { name: "Redo" }).isEnabled(), 4000, "Redo enabled");
  await pick(A, "Pen");
  await stroke(A, [0.1, 0.35], [0.4, 0.35]);
  await waitUntil(() => A.getByRole("button", { name: "Redo" }).isDisabled(), 4000, "Redo disabled after drawing");
  await same(A, B, "same picture");
  inkTwo = await ink(A);
});
await check("the eraser cannot remove somebody else's strokes", async () => {
  await pick(B, "Eraser");
  await stroke(B, [0.1, 0.15], [0.4, 0.15]);
  await stroke(B, [0.1, 0.35], [0.4, 0.35]);
  await sleep(800);
  if ((await ink(A)) !== inkTwo || (await ink(B)) !== inkTwo) throw new Error("someone else's stroke was erased");
  if ((await prisma.stroke.count({ where: { boardId } })) !== 2) throw new Error("rows changed");
  await pick(B, "Pen");
});

await check("rectangle, ellipse, line and arrow: live for others before release, and saved", async () => {
  await pick(A, "Rectangle");
  await stroke(A, [0.5, 0.1], [0.65, 0.3]);
  await pick(A, "Line");
  await stroke(A, [0.7, 0.1], [0.9, 0.3]);
  await pick(A, "Arrow");
  await stroke(A, [0.7, 0.4], [0.9, 0.55]);
  await same(A, B, "rect, line and arrow in both");
  const before = await ink(B);
  await pick(A, "Ellipse");
  await stroke(A, [0.5, 0.45], [0.65, 0.7], { release: false });
  await waitUntil(async () => (await ink(B)) > before + 200, 5000, "ellipse visible in B before release");
  await A.mouse.up();
  await same(A, B, "ellipse in both");
  const kinds = (await prisma.stroke.findMany({ where: { boardId }, select: { kind: true } })).map((r) => r.kind).sort();
  if (JSON.stringify(kinds) !== JSON.stringify(["arrow", "ellipse", "line", "pen", "pen", "rect"])) throw new Error(JSON.stringify(kinds));
  await shot(B, "f02-shapes-in-B");
  return kinds.join(",");
});
await check("an accidental click with a shape tool does not create a shape", async () => {
  const n = await prisma.stroke.count({ where: { boardId } });
  const box = (await A.locator("canvas").boundingBox())!;
  await pick(A, "Rectangle");
  await A.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.9);
  await sleep(500);
  if ((await prisma.stroke.count({ where: { boardId } })) !== n) throw new Error("a stroke was created");
});
await check("text: placed, shown to others, stored as text, and markup stays text", async () => {
  const box = (await A.locator("canvas").boundingBox())!;
  const before = await ink(B);
  await pick(A, "Text");
  await A.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.6);
  await A.getByLabel("Text to place on the board").fill("Hi <b>x</b>");
  await A.keyboard.press("Enter");
  await waitUntil(async () => (await ink(B)) > before + 100, 5000, "text visible in B");
  await same(A, B, "text in both");
  const row = await prisma.stroke.findFirstOrThrow({ where: { boardId, kind: "text" } });
  if (row.text !== "Hi <b>x</b>") throw new Error(`stored ${row.text}`);
  if ((await A.locator("b").count()) + (await B.locator("b").count()) !== 0) throw new Error("markup became an element");
  await shot(B, "f03-text-in-B");
});

await check("text typed into the box is kept when focus moves to a colour button", async () => {
  const box = (await A.locator("canvas").boundingBox())!;
  const before = await ink(B);
  await pick(A, "Text");
  await A.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.72);
  await A.getByLabel("Text to place on the board").fill("kept on blur");
  await A.getByRole("button", { name: "Blue", exact: true }).click(); // picking a colour keeps the box open
  if ((await A.getByLabel("Text to place on the board").count()) !== 1) throw new Error("the text box closed when a colour was picked");
  await A.locator("h1").click(); // clicking elsewhere moves focus away, which keeps what was typed
  await waitUntil(async () => (await ink(B)) > before + 100, 5000, "blur text visible in B");
  if (!(await prisma.stroke.findFirst({ where: { boardId, kind: "text", text: "kept on blur" } }))) throw new Error("not stored");
  await A.getByRole("button", { name: "Black", exact: true }).click();
  await pick(A, "Pen");
});
await check("an empty text box that loses focus creates nothing", async () => {
  const n = await prisma.stroke.count({ where: { boardId } });
  const box = (await A.locator("canvas").boundingBox())!;
  await pick(A, "Text");
  await A.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.9);
  await A.getByLabel("Text to place on the board").waitFor({ timeout: 3000 });
  await A.locator("h1").click(); // focus leaves the empty box
  await sleep(500);
  if ((await prisma.stroke.count({ where: { boardId } })) !== n) throw new Error("an empty text stroke was created");
  await pick(A, "Pen");
});
await check("export: SVG is escaped and complete, PNG is a real PNG, names are safe", async () => {
  const [svgDl] = await Promise.all([A.waitForEvent("download"), A.getByRole("button", { name: "Export SVG" }).click()]);
  const svg = readFileSync((await svgDl.path())!, "utf8");
  if (!svgDl.suggestedFilename().endsWith(".svg") || !/^[\p{L}\p{N}_.-]+$/u.test(svgDl.suggestedFilename())) throw new Error(svgDl.suggestedFilename());
  for (const need of ["<svg", "viewBox=\"0 0 1600 900\"", "&lt;b&gt;x&lt;/b&gt;", "<polyline", "<ellipse", "<rect"]) if (!svg.includes(need)) throw new Error(`svg is missing ${need}`);
  if (svg.includes("<b>")) throw new Error("unescaped markup in svg");
  const [pngDl] = await Promise.all([A.waitForEvent("download"), A.getByRole("button", { name: "Export PNG" }).click()]);
  const png = readFileSync((await pngDl.path())!);
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("not a PNG");
  return `${svgDl.suggestedFilename()} ${svg.length} bytes, ${pngDl.suggestedFilename()} ${png.length} bytes`;
});

await check("zoom and pan: buttons, wheel, hand tool, and drawing lands on the right canvas spot", async () => {
  await pick(A, "Pen");
  await A.getByRole("button", { name: "Zoom in" }).click();
  if ((await zoomLabel(A)) !== "125%") throw new Error(await zoomLabel(A));
  const box = (await A.locator("canvas").boundingBox())!;
  await A.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await A.keyboard.down("Control"); await A.mouse.wheel(0, -400); await A.keyboard.up("Control"); // Ctrl or Cmd with the wheel (or a trackpad pinch) zooms
  await waitUntil(async () => parseInt(await zoomLabel(A)) > 125, 3000, "wheel zoom");
  const z2 = parseInt(await zoomLabel(A));
  await A.mouse.wheel(0, 100); // a plain scroll moves the view when zoomed in and must not change the zoom
  await sleep(200);
  if (parseInt(await zoomLabel(A)) !== z2) throw new Error("a plain scroll changed the zoom");
  await A.getByRole("button", { name: "Reset zoom" }).click();
  if ((await zoomLabel(A)) !== "100%") throw new Error("reset failed");
  for (let i = 0; i < 4; i++) await A.getByRole("button", { name: "Zoom in" }).click();
  const Z = Math.pow(1.25, 4);
  if ((await zoomLabel(A)) !== `${Math.round(Z * 100)}%`) throw new Error(await zoomLabel(A));
  // hold Space and drag by 100 screen pixels to the left (works with any tool, whatever is under the pointer)
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await A.keyboard.down("Space");
  await A.mouse.move(cx, cy); await A.mouse.down(); await A.mouse.move(cx - 100, cy, { steps: 5 }); await A.mouse.up();
  await A.keyboard.up("Space");
  // draw a short mark at the screen centre; the expected canvas position follows from the pan
  await pick(A, "Pen");
  await stroke(A, [0.5, 0.5], [0.5, 0.5]);
  const expectX = Math.round(800 + (100 / box.width) * (1600 / Z)), expectY = 450;
  await A.getByRole("button", { name: "Reset zoom" }).click();
  await waitUntil(async () => (await alphaAt(A, expectX, expectY)) > 0, 4000, `ink at canvas ${expectX},${expectY} in A`);
  await waitUntil(async () => (await alphaAt(B, expectX, expectY)) > 0, 4000, `ink at canvas ${expectX},${expectY} in B`);
  await shot(A, "f04-zoom-pan-result");
  return `pan 100px at ${Math.round(Z * 100)}% put the mark at canvas ${expectX},${expectY}`;
});

await check("laser: B sees A's red laser with name, and it fades when A stops", async () => {
  await pick(A, "Laser");
  const box = (await A.locator("canvas").boundingBox())!;
  await A.mouse.move(box.x + 200, box.y + 200);
  await A.mouse.move(box.x + 240, box.y + 230, { steps: 4 });
  const sel = () => B.evaluate(() => [...document.querySelectorAll("[aria-hidden=true] div")].filter((d) => d.textContent === "Alice").map((d) => ({ glow: (d.firstElementChild as HTMLElement).style.boxShadow, shown: (d as HTMLElement).style.display !== "none" })));
  await waitUntil(async () => (await sel()).some((m) => m.glow && m.shown), 4000, "laser visible");
  await shot(B, "f05-laser-in-B");
  await waitUntil(async () => !(await sel()).some((m) => m.glow && m.shown), 5000, "laser fades");
});

await check("owner renames: others and the database follow, and the recent list shows the new name", async () => {
  await tool(A, "Rename").click();
  await A.fill("#rename", "Renamed <board>");
  await A.getByRole("button", { name: "Save" }).click();
  await waitUntil(async () => (await B.locator("h1").innerText()) === "Renamed <board>", 5000, "B title");
  if ((await A.locator("h1").innerText()) !== "Renamed <board>") throw new Error("A title");
  if ((await prisma.board.findUniqueOrThrow({ where: { id: boardId } })).name !== "Renamed <board>") throw new Error("not stored");
  await A.goto(WEB);
  const link = A.getByRole("link", { name: "Renamed <board>" });
  await link.waitFor({ timeout: 4000 });
  if ((await link.getAttribute("href")) !== `/board/${boardId}`) throw new Error(`href ${await link.getAttribute("href")}`);
  await shot(A, "f06-recent-boards");
  await A.goto(boardUrl);
  await waitUntil(async () => (await A.locator("header [role=status]").innerText()) === "Connected", 8000, "A rejoined");
  await tool(A, "Clear board").waitFor({ timeout: 4000 }); // still owner after a reload: the key was kept
});

let viewId = "";
await check("view-only visitor: sees the board, has no editing controls, cannot draw", async () => {
  viewId = (await prisma.board.findUniqueOrThrow({ where: { id: boardId } })).viewId;
  const { p: V } = await mk(1100, 700);
  await V.goto(`${WEB}/view/${viewId}`);
  await enterName(V, "Vic");
  await V.getByText("View only", { exact: true }).waitFor({ timeout: 4000 });
  const toolNames = await V.getByRole("group", { name: "Tools" }).getByRole("button").allInnerTexts();
  if (JSON.stringify(toolNames) !== JSON.stringify(["Laser", "Hand"])) throw new Error(JSON.stringify(toolNames));
  for (const n of ["Clear board", "Undo", "Redo", "Rename", "Copy link", "Copy view-only link"]) {
    if ((await V.getByRole("button", { name: n, exact: true }).count()) !== 0) throw new Error(`viewer sees "${n}"`);
  }
  await same(A, V, "viewer sees the same picture");
  const html = await V.content();
  if (html.includes(boardId)) throw new Error("the view page contains the edit id");
  const before = await prisma.stroke.count({ where: { boardId } });
  const box = (await V.locator("canvas").boundingBox())!;
  await V.mouse.move(box.x + 50, box.y + 50); await V.mouse.down(); await V.mouse.move(box.x + 300, box.y + 300, { steps: 8 }); await V.mouse.up();
  await V.keyboard.press("Control+z");
  await sleep(700);
  if ((await prisma.stroke.count({ where: { boardId } })) !== before) throw new Error("viewer changed the board");
  if ((await ink(V)) !== (await ink(A))) throw new Error("viewer drew something locally");
  // live updates still reach the viewer
  await pick(A, "Pen");
  const v0 = await ink(V);
  await stroke(A, [0.75, 0.8], [0.95, 0.8]);
  await waitUntil(async () => (await ink(V)) > v0 + 100, 5000, "live stroke reaches the viewer");
  await shot(V, "f07-view-only");
  // the edit id does not work as a view id
  const r = await V.goto(`${WEB}/view/${boardId}`);
  if (r?.status() !== 404) throw new Error(`edit id as view id gave ${r?.status()}`);
});

/* ---------- Hand tool (select and move), bound fills, own laser: a fresh board ---------- */
const { p: C } = await mk();
const { p: D } = await mk(1000, 700);
C.on("dialog", (d) => void d.accept());
C.on("pageerror", (e) => errors.push(`C: ${e.message}`));
D.on("pageerror", (e) => errors.push(`D: ${e.message}`));
await C.goto(WEB);
await C.fill("#name", "Hand and fill");
await C.click("text=Create board");
await C.waitForURL(/\/board\/[0-9a-f-]{36}/);
const board2Url = C.url().split("#")[0];
const board2 = board2Url.split("/").pop()!;
await enterName(C, "Cara");
await D.goto(board2Url);
await enterName(D, "Dan");
const cbox = (await C.locator("canvas").boundingBox())!;
const cat = (fx: number, fy: number) => [cbox.x + cbox.width * fx, cbox.y + cbox.height * fy] as const;
const alpha = (page: Page, x: number, y: number) => page.evaluate(`document.querySelector("canvas").getContext("2d").getImageData(${x},${y},1,1).data[3]`) as Promise<number>;
const rows2 = () => prisma.stroke.findMany({ where: { boardId: board2 }, orderBy: { seq: "asc" }, select: { id: true, kind: true, containerId: true, color: true, authorId: true } });
const dots = (page: Page) => page.evaluate(`[...document.querySelectorAll("[aria-hidden=true] div")].filter((d) => d.firstElementChild && d.firstElementChild.style.boxShadow).map((d) => d.textContent + ":" + d.style.display)`) as Promise<string[]>;

await check("Hand tool at 100% zoom: click selects, drag moves (for both people), Ctrl+Z moves it back", async () => {
  await stroke(C, [0.1, 0.2], [0.3, 0.2]);
  await stroke(C, [0.1, 0.5], [0.3, 0.5]);
  await waitUntil(async () => (await ink(D)) === (await ink(C)) && (await ink(C)) > 100, 5000, "strokes in D");
  await pick(C, "Hand");
  if ((await zoomLabel(C)) !== "100%") throw new Error("zoom is not 100%");
  const [x0, y0] = cat(0.2, 0.2), [x1, y1] = cat(0.2, 0.35);
  await C.mouse.move(x0, y0); await C.mouse.down(); await C.mouse.move(x0, (y0 + y1) / 2, { steps: 4 }); await C.mouse.move(x1, y1, { steps: 4 }); await C.mouse.up();
  await waitUntil(async () => (await alpha(C, 320, 315)) > 0 && (await alpha(C, 320, 180)) === 0 && (await alpha(D, 320, 315)) > 0 && (await alpha(D, 320, 180)) === 0, 5000, "moved in C and D");
  if ((await rows2()).length !== 2) throw new Error("the old row was not replaced");
  await C.keyboard.press("Control+z");
  await waitUntil(async () => (await alpha(C, 320, 180)) > 0 && (await alpha(D, 320, 180)) > 0 && (await alpha(D, 320, 315)) === 0, 5000, "moved back");
  await shot(C, "f08-hand-move");
});
await check("Hand tool: box-select several, move them together, Delete removes them; others' strokes cannot be moved", async () => {
  const [bx0, by0] = cat(0.02, 0.1), [bx1, by1] = cat(0.45, 0.6);
  await C.mouse.move(bx0, by0); await C.mouse.down(); await C.mouse.move(bx1, by1, { steps: 6 }); await C.mouse.up();
  await C.getByRole("button", { name: /Delete selection \(2\)/ }).waitFor({ timeout: 3000 });
  const [mx, my] = cat(0.2, 0.5);
  await C.mouse.move(mx, my); await C.mouse.down(); await C.mouse.move(mx + 200, my, { steps: 6 }); await C.mouse.up();
  const px = Math.round(300 + (200 / cbox.width) * 1600);
  await waitUntil(async () => (await alpha(D, px, 180)) > 0 && (await alpha(D, px, 450)) > 0 && (await alpha(D, 170, 180)) === 0, 5000, "both moved in D");
  await pick(D, "Hand");
  const dbox = (await D.locator("canvas").boundingBox())!;
  const before = await ink(C);
  await D.mouse.move(dbox.x + dbox.width * 0.5, dbox.y + dbox.height * 0.2); await D.mouse.down(); await D.mouse.move(dbox.x + dbox.width * 0.5, dbox.y + dbox.height * 0.5, { steps: 5 }); await D.mouse.up();
  await sleep(600);
  if ((await ink(C)) !== before || (await rows2()).length !== 2) throw new Error("Dan moved Cara's stroke");
  await C.mouse.move(...cat(0.1, 0.05)); await C.mouse.down(); await C.mouse.move(...cat(0.7, 0.75), { steps: 6 }); await C.mouse.up();
  await C.keyboard.press("Delete");
  await waitUntil(async () => (await rows2()).length === 0, 5000, "deleted");
});
await check("Hand tool when zoomed in: dragging empty space moves the view, a plain scroll moves it too", async () => {
  await pick(C, "Pen");
  await stroke(C, [0.45, 0.8], [0.55, 0.8]);
  await pick(C, "Hand");
  await C.getByRole("button", { name: "Zoom in" }).click(); await C.getByRole("button", { name: "Zoom in" }).click();
  await sleep(400);
  const minX = () => C.evaluate(`(() => { const c = document.querySelector("canvas"); const w = c.width, h = c.height; const d = c.getContext("2d").getImageData(0, 0, w, h).data; let m = w; for (let y = 0; y < h; y++) for (let x = 0; x < m; x++) if (d[(y * w + x) * 4 + 3] > 0) { m = x; break; } return m; })()`) as Promise<number>;
  const m0 = await minX();
  const [px, py] = cat(0.7, 0.3);
  await C.mouse.move(px, py); await C.mouse.down(); await C.mouse.move(px - 150, py, { steps: 5 }); await C.mouse.up();
  await sleep(300);
  const m1 = await minX();
  const expected = (150 / cbox.width) * 1600;
  if (Math.abs(m0 - m1 - expected) > 12) throw new Error(`left edge ${m0} to ${m1}, expected a shift of about ${Math.round(expected)}`);
  await C.mouse.move(...cat(0.5, 0.5));
  await C.mouse.wheel(60, 0);
  await sleep(300);
  if ((await minX()) >= m1) throw new Error("a plain scroll did not move the view");
  await C.getByRole("button", { name: "Reset zoom" }).click();
  await C.keyboard.press("Control+a"); await C.keyboard.press("Delete");
  await waitUntil(async () => (await rows2()).length === 0, 5000, "cleared");
});
await check("a fill belongs to its shape: it moves, undoes, deletes and erases with it, and a new colour replaces the old one", async () => {
  await pick(C, "Rectangle"); await stroke(C, [0.2, 0.2], [0.5, 0.5]);
  await C.getByRole("button", { name: "Red", exact: true }).click();
  await pick(C, "Fill"); await C.mouse.click(...cat(0.35, 0.35));
  await waitUntil(async () => (await rows2()).length === 2, 4000, "shape and fill stored");
  let r = await rows2();
  if (r[1].kind !== "fill" || r[1].containerId !== r[0].id) throw new Error("the fill does not name its shape");
  await pick(C, "Hand");
  const [sx, sy] = cat(0.35, 0.35); // inside the colour, not on the outline
  await C.mouse.move(sx, sy); await C.mouse.down(); await C.mouse.move(sx + 100, sy + 50, { steps: 5 }); await C.mouse.move(sx + 200, sy + 100, { steps: 5 }); await C.mouse.up();
  const dxC = Math.round((200 / cbox.width) * 1600), dyC = Math.round((100 / cbox.height) * 900);
  await waitUntil(async () => (await alpha(D, 560 + dxC, 315 + dyC)) > 0 && (await alpha(D, 560, 315)) === 0 && (await alpha(C, 560, 315)) === 0, 6000, "shape and fill moved for both");
  r = await rows2();
  if (r.find((x) => x.kind === "fill")!.containerId !== r.find((x) => x.kind === "rect")!.id) throw new Error("the moved fill does not name the moved shape");
  await shot(C, "f09-fill-moved-with-shape");
  await C.keyboard.press("Control+z");
  await waitUntil(async () => (await alpha(D, 560, 315)) > 0 && (await alpha(D, 560 + dxC, 315 + dyC)) === 0, 6000, "moved back together");
  await C.getByRole("button", { name: "Blue", exact: true }).click();
  await pick(C, "Fill"); await C.mouse.click(...cat(0.35, 0.35));
  await waitUntil(async () => { const x = await rows2(); return x.filter((y) => y.kind === "fill").length === 1 && x.find((y) => y.kind === "fill")!.color === "#2563eb"; }, 5000, "fill replaced, not stacked");
  await pick(C, "Hand"); await C.mouse.click(...cat(0.35, 0.35));
  await C.getByRole("button", { name: /Delete selection \(2\)/ }).waitFor({ timeout: 3000 });
  await C.keyboard.press("Delete");
  await waitUntil(async () => (await rows2()).length === 0, 5000, "shape and fill deleted");
  await pick(C, "Rectangle"); await stroke(C, [0.2, 0.2], [0.5, 0.5]);
  await pick(C, "Fill"); await C.mouse.click(...cat(0.35, 0.35));
  await waitUntil(async () => (await rows2()).length === 2, 4000, "again");
  await pick(C, "Eraser"); await stroke(C, [0.2, 0.2], [0.5, 0.2]);
  await waitUntil(async () => (await rows2()).length === 0, 5000, "erasing the outline took the fill too");
});
await check("laser: you see your own dot (the server never echoes), the other person sees yours, and it fades", async () => {
  await pick(C, "Laser");
  await C.mouse.move(...cat(0.6, 0.6)); await C.mouse.move(...cat(0.65, 0.65), { steps: 4 });
  await waitUntil(async () => (await dots(C)).some((d) => d.startsWith("You") && !d.endsWith("none")), 3000, "own dot");
  await waitUntil(async () => (await dots(D)).some((d) => d.startsWith("Cara") && !d.endsWith("none")), 3000, "dot in D");
  await sleep(2000);
  if ((await dots(C)).length !== 0) throw new Error("the dot did not fade");
  await shot(C, "f10-laser-own-dot");
});
await check("keyboard shortcuts work right after clicking a tool button (Space, Delete, Ctrl+Z are not swallowed by the button)", async () => {
  await pick(C, "Pen"); await stroke(C, [0.1, 0.8], [0.3, 0.8]);
  await waitUntil(async () => (await rows2()).length === 1, 4000, "stroke");
  await C.getByRole("button", { name: "Undo" }).click();
  await waitUntil(async () => (await rows2()).length === 0, 4000, "undo by button");
  await C.getByRole("button", { name: "Redo" }).click();
  await waitUntil(async () => (await rows2()).length === 1, 4000, "redo by button");
  await C.keyboard.press("Control+z"); // focus must not be stuck on the Redo button
  await waitUntil(async () => (await rows2()).length === 0, 4000, "Ctrl+Z after clicking a button");
});

await check("metrics are served and have counted this session", async () => {
  const text = await (await fetch(`${SOCKET}/metrics`)).text();
  const num = (n: string) => Number(new RegExp(`^${n} (\\d+)$`, "m").exec(text)?.[1] ?? NaN);
  if (!(num("whiteboard_joins_total") >= 4) || !(num("whiteboard_commits_total") >= 8)) throw new Error(text);
  return `joins=${num("whiteboard_joins_total")} commits=${num("whiteboard_commits_total")}`;
});
await check("no uncaught page errors and no CSP violations", async () => {
  if (errors.length) throw new Error(errors.join(" | "));
});

await browser.close();
socket.kill("SIGTERM"); web.kill("SIGTERM");
await prisma.board.deleteMany({ where: { id: { in: [boardId, board2] } } });
await prisma.$disconnect();
writeFileSync("logs/evidence/e2e-features-results.json", JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} feature checks passed`);
process.exit(failed ? 1 : 0);
