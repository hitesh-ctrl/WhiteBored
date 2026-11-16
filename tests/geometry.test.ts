import { describe, expect, it } from "vitest";
import { strokeBounds, strokeHit } from "../src/lib/geometry";

const pen = { kind: "pen", width: 4, points: [[100, 100], [200, 100]] as [number, number][] };

describe("strokeHit (eraser)", () => {
  it("hits a pen line near it and misses far from it", () => {
    expect(strokeHit(pen, [150, 103], 5)).toBe(true);
    expect(strokeHit(pen, [150, 120], 5)).toBe(false);
  });
  it("accounts for the end of the segment", () => {
    expect(strokeHit(pen, [205, 100], 5)).toBe(true);
    expect(strokeHit(pen, [230, 100], 5)).toBe(false);
  });
  it("hits a single-dot pen stroke", () => {
    const dot = { kind: "pen", width: 10, points: [[50, 50]] as [number, number][] };
    expect(strokeHit(dot, [53, 50], 3)).toBe(true);
    expect(strokeHit(dot, [80, 50], 3)).toBe(false);
  });
  it("hits a line and an arrow along their length", () => {
    for (const kind of ["line", "arrow"]) {
      const s = { kind, width: 2, points: [[0, 0], [100, 100]] as [number, number][] };
      expect(strokeHit(s, [50, 52], 5)).toBe(true);
      expect(strokeHit(s, [50, 90], 5)).toBe(false);
    }
  });
  it("hits a rectangle on its outline, not in the middle, whichever way the corners are given", () => {
    for (const points of [[[100, 100], [300, 200]], [[300, 200], [100, 100]]] as [number, number][][]) {
      const r = { kind: "rect", width: 2, points };
      expect(strokeHit(r, [200, 100], 5)).toBe(true);
      expect(strokeHit(r, [200, 95], 5)).toBe(true);
      expect(strokeHit(r, [200, 150], 5)).toBe(false);
      expect(strokeHit(r, [500, 500], 5)).toBe(false);
    }
  });
  it("hits an ellipse on its outline, not in the middle", () => {
    const e = { kind: "ellipse", width: 2, points: [[100, 100], [300, 200]] as [number, number][] };
    expect(strokeHit(e, [200, 100], 5)).toBe(true);
    expect(strokeHit(e, [100, 150], 5)).toBe(true);
    expect(strokeHit(e, [200, 150], 5)).toBe(false);
    expect(strokeHit(e, [110, 105], 5)).toBe(false); // the corner of the box is outside the ellipse
  });
  it("hits text anywhere in its box", () => {
    const t = { kind: "text", width: 4, text: "Hello", points: [[100, 100]] as [number, number][] };
    expect(strokeHit(t, [110, 108], 3)).toBe(true);
    expect(strokeHit(t, [400, 400], 3)).toBe(false);
  });
});

describe("strokeBounds", () => {
  it("covers the points plus half the line width", () => {
    expect(strokeBounds(pen)).toEqual({ x: 98, y: 98, w: 104, h: 4 });
  });
  it("normalises reversed corners of a rectangle", () => {
    const r = { kind: "rect", width: 2, points: [[300, 200], [100, 100]] as [number, number][] };
    expect(strokeBounds(r)).toEqual({ x: 99, y: 99, w: 202, h: 102 });
  });
});
