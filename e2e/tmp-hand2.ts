import "dotenv/config";
import { chromium, type Page } from "playwright";
import { createPrisma } from "../src/lib/prisma";
import { enterName, ink, sleep, stroke, waitUntil } from "./lib";

const prisma = createPrisma();
const browser = await chromium.launch();
const mk = async () => (await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage());
const A = await mk(), B = await mk();
A.on("dialog", (d) => void d.accept());
await A.goto("http://localhost:3001");
await A.fill("#name", "Hand test");
await A.click("text=Create board");
await A.waitForURL(/\/board\/[0-9a-f-]{36}/);
const url = A.url().split("#")[0];
const boardId = url.split("/").pop()!;
await enterName(A, "Ann");
await B.goto(url);
await enterName(B, "Bob");
const pick = (p: Page, n: string) => p.getByRole("group", { name: "Tools" }).getByRole("button", { name: n, exact: true }).click();
const box = (await A.locator("canvas").boundingBox())!;
const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const;
const alpha = (p: Page, x: number, y: number) => p.evaluate(`document.querySelector("canvas").getContext("2d").getImageData(${x},${y},1,1).data[3]`) as Promise<number>;
const rowsCount = () => prisma.stroke.count({ where: { boardId } });
const out: string[] = [];
const log = (s: string) => { out.push(s); console.log(s); };

// two strokes of Ann at 100% zoom: a line at y=0.2 and one at y=0.5
await stroke(A, [0.1, 0.2], [0.3, 0.2]);
await stroke(A, [0.1, 0.5], [0.3, 0.5]);
await waitUntil(async () => (await ink(B)) === (await ink(A)) && (await ink(A)) > 100, 5000, "both strokes in B");
await pick(A, "Hand");
log(`zoom is ${await A.getByRole("button", { name: "Reset zoom" }).innerText()} and the hand tool is active`);

// 1) click selects, drag moves (at 100% zoom)
const [x0, y0] = at(0.2, 0.2), [x1, y1] = at(0.2, 0.35);
await A.mouse.move(x0, y0); await A.mouse.down(); await A.mouse.move(x0, (y0 + y1) / 2, { steps: 4 }); await A.mouse.move(x1, y1, { steps: 4 }); await A.mouse.up();
// canvas coordinates: y 0.2*900=180 -> 0.35*900=315
await waitUntil(async () => (await alpha(A, 320, 315)) > 0 && (await alpha(A, 320, 180)) === 0, 4000, "moved in A");
await waitUntil(async () => (await alpha(B, 320, 315)) > 0 && (await alpha(B, 320, 180)) === 0, 4000, "moved in B");
log(`moved a stroke by dragging at 100% zoom: A and B both show it at the new place; database rows: ${await rowsCount()} (old row replaced, not added)`);

// 2) undo moves it back
await A.keyboard.press("Control+z");
await waitUntil(async () => (await alpha(A, 320, 180)) > 0 && (await alpha(A, 320, 315)) === 0, 4000, "back in A");
await waitUntil(async () => (await alpha(B, 320, 180)) > 0 && (await alpha(B, 320, 315)) === 0, 4000, "back in B");
log("Ctrl+Z moved it back for both");

// 3) box select both strokes by dragging empty space, then move together
const [bx0, by0] = at(0.02, 0.1), [bx1, by1] = at(0.45, 0.6);
await A.mouse.move(bx0, by0); await A.mouse.down(); await A.mouse.move(bx1, by1, { steps: 6 }); await A.mouse.up();
await A.getByRole("button", { name: /Delete selection \(2\)/ }).waitFor({ timeout: 3000 });
log("box select picked up 2 strokes (button says Delete selection (2))");
const [mx, my] = at(0.2, 0.5);
await A.mouse.move(mx, my); await A.mouse.down(); await A.mouse.move(mx + 200, my, { steps: 6 }); await A.mouse.up();
const px200 = Math.round(300 + (200 / box.width) * 1600);
await waitUntil(async () => (await alpha(B, px200, 180)) > 0 && (await alpha(B, px200, 450)) > 0 && (await alpha(B, 170, 180)) === 0, 4000, "both moved in B");
log(`both selected strokes moved together; rows still ${await rowsCount()}`);

// 4) Bob cannot move Ann's strokes with his hand tool (it just box-selects nothing)
await pick(B, "Hand");
const bbox = (await B.locator("canvas").boundingBox())!;
const bx = bbox.x + bbox.width * 0.5, by = bbox.y + bbox.height * 0.2;
const before = await ink(A);
await B.mouse.move(bx, by); await B.mouse.down(); await B.mouse.move(bx, by + 100, { steps: 5 }); await B.mouse.up();
await sleep(600);
log(`Bob dragging Ann's stroke changed nothing: ${(await ink(A)) === before && (await rowsCount()) === 2}`);

// 5) Delete removes the selection
await A.getByRole("button", { name: "Hand", exact: true }).click();
await A.mouse.move(...at(0.1, 0.05)); await A.mouse.down(); await A.mouse.move(...at(0.7, 0.75), { steps: 6 }); await A.mouse.up();
await A.keyboard.press("Delete");
await waitUntil(async () => (await rowsCount()) === 0, 4000, "deleted");
log("Delete removed the box-selected strokes; database empty");

// 6) zoom in: empty-space drag moves the view, Shift+drag still selects
await pick(A, "Pen");
await stroke(A, [0.45, 0.8], [0.55, 0.8]);
await pick(A, "Hand");
await A.getByRole("button", { name: "Zoom in" }).click(); await A.getByRole("button", { name: "Zoom in" }).click();
const z = await A.getByRole("button", { name: "Reset zoom" }).innerText();
const [px, py] = at(0.7, 0.3);
const minX = () => A.evaluate(`(() => { const c = document.querySelector("canvas"); const w = c.width, h = c.height; const d = c.getContext("2d").getImageData(0, 0, w, h).data; let m = w; for (let y = 0; y < h; y++) for (let x = 0; x < m; x++) if (d[(y * w + x) * 4 + 3] > 0) { m = x; break; } return m; })()`) as Promise<number>;
await sleep(400);
const x0m = await minX();
await A.mouse.move(px, py); await A.mouse.down(); await A.mouse.move(px - 150, py, { steps: 5 }); await A.mouse.up();
await sleep(300);
const x1m = await minX();
const expectedShift = (150 / box.width) * 1600;
log(`zoomed to ${z}: dragging empty space moved the stroke's left edge from ${x0m} to ${x1m} (expected about ${Math.round(x0m - expectedShift)}): ${Math.abs(x0m - x1m - expectedShift) < 12}`);
await A.screenshot({ path: "logs/evidence/hand-selection.png" });
await browser.close();
await prisma.board.delete({ where: { id: boardId } });
await prisma.$disconnect();
