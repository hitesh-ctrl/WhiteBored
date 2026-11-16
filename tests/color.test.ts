import { describe, expect, it } from "vitest";
import { colorFor } from "../src/lib/color";

describe("colorFor", () => {
  it("is stable for the same id", () => expect(colorFor("abc")).toBe(colorFor("abc")));
  it("returns a hsl() colour that is readable with white text", () => {
    const m = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(colorFor("some-client-id"));
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(360);
    expect(Number(m![3])).toBeLessThanOrEqual(40);
  });
  it("spreads different ids over different hues", () => {
    const hues = new Set(Array.from({ length: 40 }, (_, i) => colorFor(`client-${i}`)));
    expect(hues.size).toBeGreaterThan(20);
  });
  it("copes with empty and odd input", () => {
    for (const s of ["", " ", "\u0000", "x".repeat(10_000)]) expect(colorFor(s)).toMatch(/^hsl\(/);
  });
});
