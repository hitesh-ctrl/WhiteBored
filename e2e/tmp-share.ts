import { chromium, type Page } from "playwright";
import { enterName, ink, stroke, waitUntil } from "./lib";

const WEB = "http://192.168.1.2:3400";
const browser = await chromium.launch();
const mk = async () => await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
const A = await mk(), B = await mk(), V = await mk();
const errs: string[] = [];
for (const p of [A, B, V]) { p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); }); }
const prompts: string[] = [];
A.on("dialog", (d) => { prompts.push(d.message() + " | " + d.defaultValue()); void d.dismiss(); });

await A.goto(WEB);
await A.fill("#name", "Shared board");
await A.click("text=Create board");
await A.waitForURL(/\/board\/[0-9a-f-]{36}/);
await enterName(A, "Host");
console.log("host connected through", A.url().split("#")[0].split("/board")[0]);

// "Copy link" on a plain http page: the clipboard API is missing, so the page must show the link to copy by hand
await A.getByRole("button", { name: "Copy link", exact: true }).click();
await A.getByRole("button", { name: "Copy view-only link" }).click();
await A.waitForTimeout(300);
const [editLink, viewLink] = prompts.map((p) => p.split(" | ")[1]);
console.log("copy-link fallback showed:", editLink, "|", viewLink);
console.log("links start with the network address, not localhost, and contain no owner key:", [editLink, viewLink].every((l) => l.startsWith(WEB) && !l.includes("owner") && !l.includes("localhost")));

// a guest opens the shared edit link, a viewer opens the view-only link
await B.goto(editLink);
await enterName(B, "Guest");
await V.goto(viewLink);
await enterName(V, "Watcher");
await stroke(A, [0.1, 0.2], [0.5, 0.4]);
await waitUntil(async () => (await ink(B)) > 200 && (await ink(B)) === (await ink(A)) && (await ink(V)) === (await ink(A)), 6000, "everyone sees the stroke");
await stroke(B, [0.1, 0.6], [0.5, 0.8]);
await waitUntil(async () => (await ink(A)) === (await ink(B)) && (await ink(V)) === (await ink(B)) && (await ink(A)) > 3000, 6000, "guest's stroke reaches all");
const people = await A.locator("ul li").allInnerTexts();
console.log("people listed for the host:", JSON.stringify(people));
console.log("guest is an editor (no owner controls):", (await B.getByRole("button", { name: "Clear board" }).count()) === 0, "| watcher is view-only:", (await V.getByText("View only", { exact: true }).count()) === 1);
console.log("page errors:", errs.length ? errs.join(" | ") : "none");
await A.screenshot({ path: "logs/evidence/share-host.png" });
await browser.close();
