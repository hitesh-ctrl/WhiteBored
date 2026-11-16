import { describe, expect, it } from "vitest";
import { clampDelta, pointsBounds, translatePoints } from "../src/shared/move";
import { expandSelection, normalizeRect, rectsOverlap, selectionBounds, strokesInRect } from "../src/lib/selection";

describe("pointsBounds", () => {
  it("returns the smallest box around the points", () => {
    expect(pointsBounds([[100, 50], [200, 80], [150, 60]])).toEqual({ minX: 100, minY: 50, maxX: 200, maxY: 80 });
  });
});

describe("clampDelta", () => {
  const box = { minX: 100, minY: 50, maxX: 200, maxY: 80 };
  it("leaves a shift that stays inside the canvas alone", () => {
    expect(clampDelta(box, 30, -20)).toEqual({ dx: 30, dy: -20 });
  });
  it("stops the whole group at the canvas edges", () => {
    expect(clampDelta(box, -500, -500)).toEqual({ dx: -100, dy: -50 });
    expect(clampDelta(box, 5000, 5000)).toEqual({ dx: 1400, dy: 820 });
  });
  it("rounds to one decimal", () => {
    expect(clampDelta(box, 10.04999, 0.05001)).toEqual({ dx: 10, dy: 0.1 });
  });
  it("treats NaN and infinity as no movement", () => {
    expect(clampDelta(box, NaN, Infinity)).toEqual({ dx: 0, dy: 0 });
  });
  it("keeps every translated point inside the canvas, whatever the shift", () => {
    const pts: [number, number][] = [[0, 0], [1600, 900], [800, 450]];
    for (const [dx, dy] of [[-50, -50], [50, 50], [1e6, -1e6], [0.04, 0.06]]) {
      const c = clampDelta(pointsBounds(pts), dx, dy);
      for (const [x, y] of translatePoints(pts, c.dx, c.dy)) {
        expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1600);
        expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(900);
      }
    }
  });
});

describe("translatePoints", () => {
  it("moves every point and rounds to one decimal", () => {
    expect(translatePoints([[1, 2], [3.3, 4.4]], 10.04, -1)).toEqual([[11, 1], [13.3, 3.4]]);
  });
  it("does not change its input", () => {
    const p: [number, number][] = [[1, 1]];
    translatePoints(p, 5, 5);
    expect(p).toEqual([[1, 1]]);
  });
});

describe("rectangles", () => {
  it("normalises a rectangle dragged in any direction", () => {
    expect(normalizeRect([30, 40], [10, 5])).toEqual({ x: 10, y: 5, w: 20, h: 35 });
  });
  it("detects overlap, including touching edges, and no overlap", () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    expect(rectsOverlap(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(rectsOverlap(a, { x: 10, y: 0, w: 5, h: 5 })).toBe(true);
    expect(rectsOverlap(a, { x: 11, y: 0, w: 5, h: 5 })).toBe(false);
  });
});

describe("strokesInRect and selectionBounds", () => {
  const s = (id: string, x: number, y: number) => ({ id, kind: "rect", width: 2, points: [[x, y], [x + 20, y + 20]] as [number, number][] });
  const all = [s("a", 0, 0), s("b", 100, 100), s("c", 300, 300)];
  it("selects strokes whose box overlaps the rectangle", () => {
    expect(strokesInRect(all, { x: 90, y: 90, w: 50, h: 50 }, () => true).map((x) => x.id)).toEqual(["b"]);
    expect(strokesInRect(all, { x: -10, y: -10, w: 500, h: 500 }, () => true).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
  it("only offers strokes the filter allows (the person's own)", () => {
    expect(strokesInRect(all, { x: -10, y: -10, w: 500, h: 500 }, (x) => x.id !== "b").map((x) => x.id)).toEqual(["a", "c"]);
  });
  it("gives the box around a selection and null for an empty one", () => {
    expect(selectionBounds([all[0], all[1]])).toEqual({ x: -1, y: -1, w: 122, h: 122 });
    expect(selectionBounds([])).toBeNull();
  });
});

describe("expandSelection (a fill goes with its shape)", () => {
  const shape = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: "rect", authorId: "me", ...over });
  const fill = (id: string, containerId?: string, over: Record<string, unknown> = {}) => ({ id, kind: "fill", authorId: "me", containerId, ...over });
  const mine = () => true;
  const list = [shape("r1"), fill("f1", "r1"), fill("f2", "r1"), shape("r2"), fill("f3", "r2"), fill("loose")];
  it("adds the fills of a selected shape", () => {
    expect([...expandSelection(list, new Set(["r1"]), mine)].sort()).toEqual(["f1", "f2", "r1"]);
  });
  it("turns a selected fill into its shape plus all that shape's fills", () => {
    expect([...expandSelection(list, new Set(["f1"]), mine)].sort()).toEqual(["f1", "f2", "r1"]);
  });
  it("leaves other shapes and loose fills alone, and keeps a fill whose shape is gone", () => {
    expect([...expandSelection(list, new Set(["loose"]), mine)]).toEqual(["loose"]);
    expect([...expandSelection([fill("orphan", "missing")], new Set(["orphan"]), mine)]).toEqual(["orphan"]);
  });
  it("never adds strokes the filter refuses (somebody else's)", () => {
    const l = [shape("r1", { authorId: "you" }), fill("f1", "r1")];
    const own = (s: { authorId: string }) => s.authorId === "me";
    expect([...expandSelection(l, new Set(["f1"]), own)]).toEqual(["f1"]);
    const l2 = [shape("r1"), fill("f1", "r1", { authorId: "you" })];
    expect([...expandSelection(l2, new Set(["r1"]), own)]).toEqual(["r1"]);
  });
  it("is stable when applied twice and does not change its input", () => {
    const start = new Set(["r2"]);
    const once = expandSelection(list, start, mine);
    expect([...expandSelection(list, once, mine)].sort()).toEqual([...once].sort());
    expect([...start]).toEqual(["r2"]);
  });
});
