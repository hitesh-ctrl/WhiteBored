import { describe, expect, it } from "vitest";
import { TEMPLATES, TEMPLATE_KEYS, isTemplateKey } from "../src/shared/templates";
import { imageHeaders } from "../src/lib/imageResponse";

describe("built-in pictures", () => {
  it("offers at least seven, each with a unique plain key and a label", () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(7);
    expect(new Set(TEMPLATES.map((t) => t.key)).size).toBe(TEMPLATES.length);
    for (const t of TEMPLATES) { expect(t.key).toMatch(/^[a-z]+$/); expect(t.label.length).toBeGreaterThan(0); }
  });
  it("includes the ones the interface promises", () => {
    for (const k of ["house", "tree", "cat", "face", "heart", "star", "grid"]) expect(isTemplateKey(k)).toBe(true);
  });
  it("describes every outline with plain path commands only (nothing that could carry markup)", () => {
    for (const t of TEMPLATES) expect(t.path).toMatch(/^[MmLlHhVvCcSsAaZz0-9 .,-]+$/);
  });
  it("knows exactly its own keys", () => {
    expect([...TEMPLATE_KEYS].sort()).toEqual(TEMPLATES.map((t) => t.key).sort());
    for (const bad of ["", "House", "../etc", "constructor", "__proto__", "house ", "toString"]) expect(isTemplateKey(bad)).toBe(false);
  });
});

describe("imageHeaders (how an uploaded picture is sent to a browser)", () => {
  it("sends the stored type, forbids guessing, blocks everything if the file is opened directly, and caches it for good", () => {
    const h = imageHeaders("image/png")!;
    expect(h["content-type"]).toBe("image/png");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["content-security-policy"]).toContain("default-src 'none'");
    expect(h["content-security-policy"]).toContain("sandbox");
    expect(h["cache-control"]).toContain("immutable");
  });
  it("accepts only the three allowed types and nothing else, whatever the database says", () => {
    for (const m of ["image/jpeg", "image/png", "image/webp"]) expect(imageHeaders(m)).not.toBeNull();
    for (const m of ["image/svg+xml", "text/html", "image/gif", "application/javascript", "", "image/png; charset=x", "IMAGE/PNG", null as unknown as string]) expect(imageHeaders(m)).toBeNull();
  });
});
