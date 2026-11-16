import "dotenv/config";
import { chromium, type Page } from "playwright";
import { createPrisma } from "../src/lib/prisma";
import { enterName, sleep, stroke, waitUntil } from "./lib";

const prisma = createPrisma();
const browser = await chromium.launch();
const mk = async () => await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
const A = await mk(), B = await mk();
A.on("dialog", (d) => void d.accept());
const errs: string[] = [];
for (const p of [A, B]) { p.on("pageerror", (e) => errs.push(e.message)); }
await A.goto("http://localhost:3001");
await A.fill("#name", "Bind test");
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
const rows = () => prisma.stroke.findMany({ where: { boardId }, orderBy: { seq: "asc" }, select: { id: true, kind: true, containerId: true, color: true } });
const log = (s: string) => console.log(s);

// rectangle (canvas x 320..800, y 180..450), filled red
await pick(A, "Rectangle"); await stroke(A, [0.2, 0.2], [0.5, 0.5]);
await A.getByRole("button", { name: "Red", exact: true }).click();
await pick(A, "Fill"); await A.mouse.click(...at(0.35, 0.35));
await waitUntil(async () => (await rows()).length === 2, 4000, "rect + fill stored");
let r = await rows();
log(`stored: ${r.map((x) => x.kind).join(", ")}; fill.containerId == rect.id: ${r[1].containerId === r[0].id}`);
await waitUntil(async () => (await alpha(B, 560, 315)) > 0, 4000, "fill visible in B");

// Hand: click INSIDE the red fill and drag right+down by 200px x 100px
await pick(A, "Hand");
const [sx, sy] = at(0.35, 0.35);
await A.mouse.move(sx, sy); await A.mouse.down(); await A.mouse.move(sx + 100, sy + 50, { steps: 5 }); await A.mouse.move(sx + 200, sy + 100, { steps: 5 }); await A.mouse.up();
const dxC = Math.round((200 / box.width) * 1600), dyC = Math.round((100 / box.height) * 900);
await waitUntil(async () => (await alpha(A, 560 + dxC, 315 + dyC)) > 0 && (await alpha(A, 560, 315)) === 0 && (await alpha(B, 560 + dxC, 315 + dyC)) > 0 && (await alpha(B, 560, 315)) === 0, 5000, "rect and fill moved in A and B");
r = await rows();
log(`click inside the colour and drag: shape AND fill moved for both people (the old spot is empty, the new spot is red); rows ${r.length}; fill.containerId == new rect id: ${r.find((x) => x.kind === "fill")!.containerId === r.find((x) => x.kind === "rect")!.id}`);
await A.screenshot({ path: "logs/evidence/fill-bound-moved.png" });

// undo moves both back
await A.keyboard.press("Control+z");
await waitUntil(async () => (await alpha(A, 560, 315)) > 0 && (await alpha(B, 560, 315)) > 0 && (await alpha(B, 560 + dxC, 315 + dyC)) === 0, 5000, "back");
r = await rows();
log(`Ctrl+Z moved shape and fill back together; link intact: ${r.find((x) => x.kind === "fill")!.containerId === r.find((x) => x.kind === "rect")!.id}`);

// filling again replaces instead of stacking
await A.getByRole("button", { name: "Blue", exact: true }).click();
await pick(A, "Fill"); await A.mouse.click(...at(0.35, 0.35));
await waitUntil(async () => { const x = await rows(); return x.filter((y) => y.kind === "fill").length === 1 && x.find((y) => y.kind === "fill")!.color === "#2563eb"; }, 5000, "fill replaced");
log(`filling again with blue replaced the red fill: ${(await rows()).length} rows (rect + one fill)`);

// Delete selection removes both
await pick(A, "Hand"); await A.mouse.click(...at(0.35, 0.35));
await A.getByRole("button", { name: /Delete selection \(2\)/ }).waitFor({ timeout: 3000 });
await A.keyboard.press("Delete");
await waitUntil(async () => (await rows()).length === 0, 5000, "both deleted");
log("selecting by the colour picked shape + fill (2); Delete removed both");

// eraser on the outline removes shape and fill
await pick(A, "Rectangle"); await stroke(A, [0.2, 0.2], [0.5, 0.5]);
await A.getByRole("button", { name: "Green", exact: true }).click();
await pick(A, "Fill"); await A.mouse.click(...at(0.35, 0.35));
await waitUntil(async () => (await rows()).length === 2, 4000, "again");
await pick(A, "Eraser"); await stroke(A, [0.2, 0.2], [0.5, 0.2]);
await waitUntil(async () => (await rows()).length === 0, 5000, "erased both");
log("erasing the outline removed the fill with it");

// laser: own dot visible to the sender, and to the other person
await pick(A, "Laser");
await A.mouse.move(...at(0.6, 0.6)); await A.mouse.move(...at(0.65, 0.65), { steps: 4 });
const dots = (p: Page) => p.evaluate(`[...document.querySelectorAll("[aria-hidden=true] div")].filter((d) => d.firstElementChild && d.firstElementChild.style.boxShadow).map((d) => d.textContent + ":" + d.style.display)`) as Promise<string[]>;
await waitUntil(async () => (await dots(A)).some((d) => d.startsWith("You") && !d.endsWith("none")), 3000, "own laser");
await waitUntil(async () => (await dots(B)).some((d) => d.startsWith("Ann") && !d.endsWith("none")), 3000, "laser in B");
log(`laser: Ann sees her own dot ${JSON.stringify(await dots(A))} and Bob sees ${JSON.stringify(await dots(B))}`);
await sleep(2000);
log(`and it fades when she stops: ${(await dots(A)).length === 0}`);
await A.screenshot({ path: "logs/evidence/laser-own.png" });
log(`page errors: ${errs.length ? errs.join(" | ") : "none"}`);
await browser.close();
await prisma.board.delete({ where: { id: boardId } });
await prisma.$disconnect();
