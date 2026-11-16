import { describe, expect, it } from "vitest";
import { PALETTE, normalizeHex, parseRecentColors, rememberColor } from "../src/lib/palette";

describe("PALETTE", () => {
  it("offers at least 24 colours, each a name and a six digit lower-case code, with no repeats", () => {
    expect(PALETTE.length).toBeGreaterThanOrEqual(24);
    for (const [name, hex] of PALETTE) { expect(name.length).toBeGreaterThan(0); expect(hex).toMatch(/^#[0-9a-f]{6}$/); }
    expect(new Set(PALETTE.map((c) => c[1])).size).toBe(PALETTE.length);
    expect(new Set(PALETTE.map((c) => c[0])).size).toBe(PALETTE.length);
  });
  it("keeps the colours people already know, with the same names", () => {
    const names = Object.fromEntries(PALETTE.map(([n, h]) => [n, h]));
    expect(names).toMatchObject({ Black: "#111827", Red: "#dc2626", Orange: "#ea580c", Green: "#16a34a", Blue: "#2563eb", Purple: "#7c3aed", Pink: "#db2777", White: "#ffffff" });
  });
});

describe("normalizeHex", () => {
  it("accepts six digits with or without #, in any case, and gives #rrggbb", () => {
    expect(normalizeHex("#FFAA00")).toBe("#ffaa00");
    expect(normalizeHex("ffaa00")).toBe("#ffaa00");
    expect(normalizeHex("  #12AbCd ")).toBe("#12abcd");
  });
  it("expands three digits", () => expect(normalizeHex("#f0a")).toBe("#ff00aa"));
  it("refuses anything else", () => {
    for (const bad of ["", "#12", "#12345", "#1234567", "#gggggg", "red", "rgb(1,2,3)", "#12345g", "<script>", "#ff00aa; x", null, undefined, 5]) expect(normalizeHex(bad as never)).toBeNull();
  });
});

describe("rememberColor", () => {
  it("puts the newest custom colour first and drops repeats", () => {
    expect(rememberColor(["#111111", "#222222"], "#333333")).toEqual(["#333333", "#111111", "#222222"]);
    expect(rememberColor(["#111111", "#222222"], "#222222")).toEqual(["#222222", "#111111"]);
  });
  it("keeps at most 8 and ignores colours already in the palette and invalid ones", () => {
    let list: string[] = [];
    for (let i = 0; i < 12; i++) list = rememberColor(list, `#0000${String(i).padStart(2, "0")}`);
    expect(list).toHaveLength(8);
    expect(rememberColor(["#111111"], "#DC2626")).toEqual(["#111111"]); // Red is in the palette
    expect(rememberColor(["#111111"], "nope")).toEqual(["#111111"]);
  });
});

describe("parseRecentColors", () => {
  it("returns a clean list from storage and an empty one for anything unusable", () => {
    expect(parseRecentColors('["#AABBCC","#112233"]')).toEqual(["#aabbcc", "#112233"]);
    for (const bad of [null, "", "nope", "{}", "5", '"x"']) expect(parseRecentColors(bad)).toEqual([]);
  });
  it("drops invalid entries, repeats and anything past 8", () => {
    expect(parseRecentColors(JSON.stringify(["#aabbcc", "junk", 5, "#AABBCC", "<b>"]))).toEqual(["#aabbcc"]);
    expect(parseRecentColors(JSON.stringify(Array.from({ length: 20 }, (_, i) => `#0000${String(i).padStart(2, "0")}`)))).toHaveLength(8);
  });
});
