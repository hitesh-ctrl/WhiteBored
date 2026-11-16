import { describe, expect, it } from "vitest";
import { clampImageRect, fitRect, onHandle, rectContains, resizeKeepAspect } from "../src/lib/imageLayer";

describe("fitRect (where a new picture goes)", () => {
  it("centres a wide picture and keeps its shape, using up to 70% of the board", () => {
    expect(fitRect(2000, 1000)).toEqual({ x: 240, y: 170, w: 1120, h: 560 });
  });
  it("is limited by the height for a square picture", () => {
    expect(fitRect(100, 100)).toEqual({ x: 485, y: 135, w: 630, h: 630 });
  });
  it("makes a small picture bigger and a tall one fit", () => {
    const r = fitRect(50, 200);
    expect(r.h).toBeCloseTo(630);
    expect(r.w / r.h).toBeCloseTo(0.25);
  });
  it("copes with a zero size", () => {
    const r = fitRect(0, 0);
    expect(Number.isFinite(r.w) && Number.isFinite(r.h) && r.w > 0 && r.h > 0).toBe(true);
  });
});

describe("resizeKeepAspect", () => {
  const r = { x: 10, y: 10, w: 200, h: 100 };
  it("scales from the top left corner and keeps the shape", () => expect(resizeKeepAspect(r, 400)).toEqual({ x: 10, y: 10, w: 400, h: 200 }));
  it("never goes below 40 wide or above 3200 wide", () => {
    expect(resizeKeepAspect(r, 5)).toEqual({ x: 10, y: 10, w: 40, h: 20 });
    expect(resizeKeepAspect(r, 99999).w).toBe(3200);
  });
  it("ignores a width that is not a number", () => expect(resizeKeepAspect(r, NaN)).toEqual(r));
});

describe("hit tests", () => {
  const r = { x: 100, y: 100, w: 200, h: 100 };
  it("rectContains includes the edges and excludes outside points", () => {
    expect(rectContains(r, [100, 100])).toBe(true);
    expect(rectContains(r, [300, 200])).toBe(true);
    expect(rectContains(r, [301, 150])).toBe(false);
  });
  it("onHandle is the bottom right corner within a radius", () => {
    expect(onHandle(r, [300, 200], 10)).toBe(true);
    expect(onHandle(r, [308, 205], 10)).toBe(true);
    expect(onHandle(r, [100, 100], 10)).toBe(false);
    expect(onHandle(r, [320, 200], 10)).toBe(false);
  });
});

describe("clampImageRect (the ranges the server accepts)", () => {
  it("keeps position and size in range and rounds to one decimal", () => {
    expect(clampImageRect({ x: -5000, y: 9999, w: 10, h: 99999 })).toEqual({ x: -800, y: 1350, w: 20, h: 3200 });
    expect(clampImageRect({ x: 10.04, y: 20.06, w: 100.04, h: 50 })).toEqual({ x: 10, y: 20.1, w: 100, h: 50 });
  });
});
