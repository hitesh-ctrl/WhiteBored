import { describe, expect, it } from "vitest";
import { closedPolygon, findFillContainer, findFillTarget, pointInPolygon } from "../src/lib/fill";

type P = [number, number];
const rect = (a: P, b: P) => ({ kind: "rect", width: 2, points: [a, b] });
const square: P[] = [[0, 0], [100, 0], [100, 100], [0, 100]];

describe("pointInPolygon", () => {
  it("is true inside and false outside, for a concave shape too", () => {
    expect(pointInPolygon([50, 50], square)).toBe(true);
    expect(pointInPolygon([150, 50], square)).toBe(false);
    const L: P[] = [[0, 0], [100, 0], [100, 40], [40, 40], [40, 100], [0, 100]];
    expect(pointInPolygon([20, 80], L)).toBe(true);
    expect(pointInPolygon([80, 80], L)).toBe(false);
  });
  it("is false for fewer than 3 points", () => {
    expect(pointInPolygon([1, 1], [[0, 0], [2, 2]])).toBe(false);
  });
});

describe("closedPolygon", () => {
  it("gives the 4 corners of a rectangle whichever way the corners were dragged", () => {
    const expected = [[100, 100], [300, 100], [300, 200], [100, 200]];
    expect(closedPolygon(rect([100, 100], [300, 200]))).toEqual(expected);
    expect(closedPolygon(rect([300, 200], [100, 100]))).toEqual(expected);
  });
  it("approximates an ellipse with a polygon that stays inside its box", () => {
    const poly = closedPolygon({ kind: "ellipse", width: 2, points: [[100, 100], [300, 200]] })!;
    expect(poly.length).toBeGreaterThanOrEqual(32);
    expect(pointInPolygon([200, 150], poly)).toBe(true);
    expect(pointInPolygon([105, 105], poly)).toBe(false);
    for (const [x, y] of poly) { expect(x).toBeGreaterThanOrEqual(99.9); expect(x).toBeLessThanOrEqual(300.1); expect(y).toBeGreaterThanOrEqual(99.9); expect(y).toBeLessThanOrEqual(200.1); }
  });
  it("treats a pen path whose end returns near its start as a closed loop", () => {
    const loop: P[] = [[0, 0], [100, 0], [100, 100], [0, 100], [6, 4]];
    expect(closedPolygon({ kind: "pen", width: 3, points: loop })).toEqual(loop);
  });
  it("does not treat an open pen path, a dot, or a short scribble as closed", () => {
    expect(closedPolygon({ kind: "pen", width: 3, points: [[0, 0], [100, 0], [100, 100], [0, 100], [0, 60]] })).toBeNull();
    expect(closedPolygon({ kind: "pen", width: 3, points: [[5, 5]] })).toBeNull();
    expect(closedPolygon({ kind: "pen", width: 3, points: [[0, 0], [3, 3], [1, 1]] })).toBeNull();
  });
  it("has no polygon for lines, arrows, text or fills", () => {
    for (const kind of ["line", "arrow", "text", "fill"]) expect(closedPolygon({ kind, width: 2, points: [[0, 0], [10, 10]] })).toBeNull();
  });
});

describe("findFillTarget", () => {
  it("returns the polygon of the closed shape under the point", () => {
    expect(findFillTarget([rect([0, 0], [100, 100])], [50, 50])).toEqual(square);
  });
  it("returns null when the point is outside every closed shape", () => {
    expect(findFillTarget([rect([0, 0], [100, 100])], [200, 200])).toBeNull();
    expect(findFillTarget([], [1, 1])).toBeNull();
  });
  it("picks the shape drawn last when shapes overlap", () => {
    const outer = rect([0, 0], [300, 300]), inner = rect([100, 100], [200, 200]);
    expect(findFillTarget([outer, inner], [150, 150])).toEqual(closedPolygon(inner));
    expect(findFillTarget([outer, inner], [20, 20])).toEqual(closedPolygon(outer));
    expect(findFillTarget([inner, outer], [150, 150])).toEqual(closedPolygon(outer));
  });
  it("ignores existing fills and open shapes", () => {
    const fill = { kind: "fill", width: 1, points: square };
    expect(findFillTarget([fill], [50, 50])).toBeNull();
    expect(findFillTarget([{ kind: "line", width: 2, points: [[0, 0], [100, 100]] }], [50, 50])).toBeNull();
  });
  it("never returns more than 5000 points", () => {
    const big: P[] = Array.from({ length: 5000 }, (_, i) => [50 + 40 * Math.cos(i / 800), 50 + 40 * Math.sin(i / 800)]);
    big[4999] = [...big[0]] as P;
    const t = findFillTarget([{ kind: "pen", width: 2, points: big }], [50, 50]);
    expect(t === null || t.length <= 5000).toBe(true);
  });
});

describe("findFillContainer", () => {
  const withId = (id: string, a: P, b: P) => ({ id, ...rect(a, b) });
  it("returns the id and polygon of the shape that would be filled", () => {
    expect(findFillContainer([withId("r1", [0, 0], [100, 100])], [50, 50])).toEqual({ id: "r1", polygon: square });
  });
  it("picks the shape drawn last, ignores fills, and returns null when nothing encloses the point", () => {
    const list = [withId("outer", [0, 0], [300, 300]), withId("inner", [100, 100], [200, 200]), { id: "f", kind: "fill", width: 1, points: square }];
    expect(findFillContainer(list, [150, 150])?.id).toBe("inner");
    expect(findFillContainer(list, [20, 20])?.id).toBe("outer");
    expect(findFillContainer(list, [900, 900])).toBeNull();
  });
});
