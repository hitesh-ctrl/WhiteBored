import { describe, expect, it } from "vitest";
import { safeFileName } from "../src/lib/render";

describe("safeFileName", () => {
  it("keeps letters, digits, dash and underscore and joins the rest with dashes", () => {
    expect(safeFileName("My board: v2!", "png")).toBe("My-board-v2.png");
  });
  it("cannot contain path separators or dots from the name", () => {
    expect(safeFileName("../../etc/passwd", "svg")).toBe("etc-passwd.svg");
    expect(safeFileName("a.b.c", "svg")).toBe("a-b-c.svg");
  });
  it("falls back to a default for names with no usable characters", () => {
    expect(safeFileName("<>:/\\|?*", "png")).toBe("board.png");
    expect(safeFileName("", "png")).toBe("board.png");
  });
  it("keeps non-latin letters and limits the length", () => {
    expect(safeFileName("Ünïcode 板", "png")).toBe("Ünïcode-板.png");
    expect(safeFileName("x".repeat(200), "png").length).toBe(44);
  });
});
