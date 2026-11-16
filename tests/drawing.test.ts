import { describe, expect, it } from "vitest";
import { nextBatch, ownStrokeIds, shouldAddPoint, toCanvasPoint } from "../src/lib/drawing";

const rect = { left: 100, top: 50, width: 800, height: 450 }; // half-size canvas

describe("toCanvasPoint", () => {
  it("scales screen coordinates to the 1600x900 canvas", () => {
    expect(toCanvasPoint(500, 275, rect)).toEqual([800, 450]);
  });
  it("rounds to one decimal", () => {
    expect(toCanvasPoint(100.13, 50.07, rect)).toEqual([0.3, 0.1]);
  });
  it("clamps to the canvas", () => {
    expect(toCanvasPoint(0, 0, rect)).toEqual([0, 0]);
    expect(toCanvasPoint(5000, 5000, rect)).toEqual([1600, 900]);
  });
  it("returns finite numbers for a zero-size rect", () => {
    const p = toCanvasPoint(10, 10, { left: 0, top: 0, width: 0, height: 0 });
    expect(p.every(Number.isFinite)).toBe(true);
  });
});

describe("shouldAddPoint", () => {
  it("always accepts the first point", () => expect(shouldAddPoint(undefined, [1, 1])).toBe(true));
  it("skips points closer than 1 unit", () => expect(shouldAddPoint([10, 10], [10.5, 10.5])).toBe(false));
  it("accepts a point exactly 1 unit away", () => expect(shouldAddPoint([10, 10], [11, 10])).toBe(true));
  it("accepts far points", () => expect(shouldAddPoint([0, 0], [50, 50])).toBe(true));
});

describe("nextBatch", () => {
  const pts = (n: number): [number, number][] => Array.from({ length: n }, (_, i) => [i, i]);
  it("returns null when nothing is new", () => expect(nextBatch(pts(3), 3)).toBeNull());
  it("sends everything the first time", () => {
    expect(nextBatch(pts(3), 0)).toEqual({ batch: pts(3), sent: 3 });
  });
  it("starts each later batch with the previous batch's last point", () => {
    const r = nextBatch(pts(6), 3)!;
    expect(r.batch).toEqual([[2, 2], [3, 3], [4, 4], [5, 5]]);
    expect(r.sent).toBe(6);
  });
  it("never exceeds 200 points per batch and resumes where it stopped", () => {
    const all = pts(450);
    const first = nextBatch(all, 0)!;
    expect(first.batch).toHaveLength(200);
    expect(first.sent).toBe(200);
    const second = nextBatch(all, first.sent)!;
    expect(second.batch).toHaveLength(200);
    expect(second.batch[0]).toEqual(first.batch[199]);
    const third = nextBatch(all, second.sent)!;
    expect(third.batch[0]).toEqual(second.batch[199]);
    expect(third.sent).toBe(450);
    expect(nextBatch(all, third.sent)).toBeNull();
  });
});

describe("ownStrokeIds", () => {
  it("returns the client's own stroke ids in draw order", () => {
    const strokes = [
      { id: "a", authorId: "me" }, { id: "b", authorId: "you" }, { id: "c", authorId: "me" },
    ];
    expect(ownStrokeIds(strokes, "me")).toEqual(["a", "c"]);
  });
});
