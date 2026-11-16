import { describe, expect, it } from "vitest";
import { scaledSize } from "../src/lib/imageUpload";

describe("scaledSize (shrinking a picture before it is sent)", () => {
  it("leaves a picture that is already small enough", () => {
    expect(scaledSize(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });
  it("shrinks the longer side to the limit and keeps the shape", () => {
    expect(scaledSize(4000, 2000, 1600)).toEqual({ width: 1600, height: 800 });
    expect(scaledSize(1000, 5000, 1600)).toEqual({ width: 320, height: 1600 });
  });
  it("never returns less than one pixel on a side", () => {
    const s = scaledSize(10000, 1, 1600);
    expect(s.width).toBe(1600);
    expect(s.height).toBe(1);
  });
  it("copes with nonsense sizes", () => {
    for (const [w, h] of [[0, 0], [-5, 10], [NaN, 5], [Infinity, 5]]) {
      const s = scaledSize(w, h, 1600);
      expect(Number.isInteger(s.width) && Number.isInteger(s.height) && s.width >= 1 && s.height >= 1).toBe(true);
    }
  });
});
