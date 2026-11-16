import { describe, expect, it } from "vitest";
import { dilate, fillPolygonFromWalls } from "../src/lib/floodFill";

const W = 120, H = 100;
const blank = () => new Uint8Array(W * H);
/** A square ring of walls with outer corner (x0,y0), side `side` and wall thickness `t`; `gap` cuts a hole in the top wall. */
function ring(x0: number, y0: number, side: number, t: number, gap = 0, m = blank()) {
  for (let y = y0; y < y0 + side; y++) for (let x = x0; x < x0 + side; x++) {
    const wall = x < x0 + t || x >= x0 + side - t || y < y0 + t || y >= y0 + side - t;
    if (wall) m[y * W + x] = 1;
  }
  if (gap) for (let x = x0 + Math.floor(side / 2); x < x0 + Math.floor(side / 2) + gap; x++) for (let y = y0; y < y0 + t; y++) m[y * W + x] = 0;
  return m;
}
const bbox = (pts: [number, number][]) => ({ minX: Math.min(...pts.map((p) => p[0])), maxX: Math.max(...pts.map((p) => p[0])), minY: Math.min(...pts.map((p) => p[1])), maxY: Math.max(...pts.map((p) => p[1])) });
const area = (pts: [number, number][]) => Math.abs(pts.reduce((s, [x1, y1], i) => { const [x2, y2] = pts[(i + 1) % pts.length]; return s + (x1 * y2 - x2 * y1); }, 0)) / 2;

describe("dilate", () => {
  it("grows set pixels by the radius in every direction and leaves the rest", () => {
    const m = blank(); m[50 * W + 60] = 1;
    const d = dilate(m, W, H, 2);
    expect(d[50 * W + 62]).toBe(1); expect(d[48 * W + 58]).toBe(1); expect(d[50 * W + 63]).toBe(0);
    expect(d.reduce((a, b) => a + b, 0)).toBe(25);
  });
  it("does not change the mask it is given and copes with radius 0 and the edges", () => {
    const m = blank(); m[0] = 1;
    const copy = Uint8Array.from(m);
    expect(dilate(m, W, H, 0)).toEqual(m);
    dilate(m, W, H, 3);
    expect(m).toEqual(copy);
    expect(dilate(m, W, H, 3)[3 * W + 3]).toBe(1);
  });
});

describe("fillPolygonFromWalls", () => {
  it("fills the inside of a closed ring, a little under the walls so no gap shows beside the line", () => {
    // the walls are 3 thick (x 20 to 22 and 77 to 79), so the free inside is 23 to 76; closing gaps hides 2 more pixels
    // of it from the search, and growing by 4 spreads the colour 2 pixels under each wall
    const r = fillPolygonFromWalls(ring(20, 20, 60, 3), W, H, 50, 50, { close: 2, grow: 4 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = bbox(r.points);
    expect(b.minX).toBe(21); expect(b.maxX).toBe(79); expect(b.minY).toBe(21); expect(b.maxY).toBe(79);
    expect(area(r.points)).toBeGreaterThan(54 * 54);
    expect(area(r.points)).toBeLessThan(60 * 60);
  });
  it("closes a small gap in the outline", () => {
    expect(fillPolygonFromWalls(ring(20, 20, 60, 3, 4), W, H, 50, 50, { close: 3, grow: 3 }).ok).toBe(true);
  });
  it("refuses an area whose outline has a gap that is too large, saying the area leaks", () => {
    expect(fillPolygonFromWalls(ring(20, 20, 60, 3, 12), W, H, 50, 50, { close: 3, grow: 3 })).toEqual({ ok: false, reason: "leak" });
  });
  it("refuses a click in open space", () => {
    expect(fillPolygonFromWalls(ring(20, 20, 60, 3), W, H, 5, 5, { close: 2, grow: 2 })).toEqual({ ok: false, reason: "leak" });
  });
  it("moves a click that lands on a thin line into the area next to it", () => {
    const r = fillPolygonFromWalls(ring(20, 20, 60, 3), W, H, 21, 50, { close: 2, grow: 2 }); // on the left wall
    expect(r.ok).toBe(true);
  });
  it("refuses a click in the middle of a thick wall", () => {
    const m = blank();
    for (let y = 30; y < 70; y++) for (let x = 30; x < 70; x++) m[y * W + x] = 1;
    expect(fillPolygonFromWalls(m, W, H, 50, 50, { close: 2, grow: 2 })).toEqual({ ok: false, reason: "wall" });
  });
  it("refuses a speck too small to be an area", () => {
    const m = ring(20, 20, 9, 4); // an inside of 1 pixel
    expect(fillPolygonFromWalls(m, W, H, 24, 24, { close: 0, grow: 0 })).toEqual({ ok: false, reason: "tiny" });
  });
  it("fills the ring between two nested shapes as the outer outline of that region", () => {
    const m = ring(10, 10, 85, 3); // walls from 10 to 94, inside 13 to 91
    ring(35, 35, 30, 3, 0, m);
    const r = fillPolygonFromWalls(m, W, H, 20, 20, { close: 2, grow: 2 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(area(r.points)).toBeGreaterThan(75 * 75);
  });
  it("traces a round shape with a modest number of points", () => {
    const m = blank();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const d = Math.hypot(x - 60, y - 50); if (d >= 33 && d < 36) m[y * W + x] = 1; }
    const r = fillPolygonFromWalls(m, W, H, 60, 50, { close: 1, grow: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.points.length).toBeGreaterThan(8); expect(r.points.length).toBeLessThan(150); expect(area(r.points)).toBeGreaterThan(Math.PI * 30 * 30); }
  });
  it("never returns more than 1500 points", () => {
    const m = blank();
    for (let y = 10; y < 90; y++) for (let x = 10; x < 110; x++) { const edge = x < 12 || x >= 108 || y < 12 || y >= 88; const zig = (x + (y % 2)) % 2 === 0 && x > 20 && x < 100 && y > 20 && y < 80 && x % 3 === 0; if (edge || zig) m[y * W + x] = 1; }
    const r = fillPolygonFromWalls(m, W, H, 15, 15, { close: 0, grow: 0 });
    if (r.ok) expect(r.points.length).toBeLessThanOrEqual(1500);
  });
  it("is fast on a full-size board", () => {
    const w = 800, h = 450, m = new Uint8Array(w * h);
    for (let y = 50; y < 400; y++) for (let x = 100; x < 700; x++) if (x < 104 || x >= 696 || y < 54 || y >= 396) m[y * w + x] = 1;
    const t = performance.now();
    const r = fillPolygonFromWalls(m, w, h, 400, 225, { close: 3, grow: 3 });
    expect(r.ok).toBe(true);
    expect(performance.now() - t).toBeLessThan(400);
  });
  it("does not change the walls it is given", () => {
    const m = ring(20, 20, 60, 3);
    const copy = Uint8Array.from(m);
    fillPolygonFromWalls(m, W, H, 50, 50, { close: 2, grow: 2 });
    expect(m).toEqual(copy);
  });
  it("returns whole-number corner points inside the picture", () => {
    const r = fillPolygonFromWalls(ring(20, 20, 60, 3), W, H, 50, 50, { close: 2, grow: 2 });
    if (!r.ok) throw new Error("expected a polygon");
    for (const [x, y] of r.points) { expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true); expect(x >= 0 && x <= W && y >= 0 && y <= H).toBe(true); }
  });
});
