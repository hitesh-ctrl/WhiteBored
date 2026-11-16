import { describe, expect, it } from "vitest";
import { renderOrder, safeFileName } from "../src/lib/render";

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

describe("renderOrder", () => {
  it("puts fills under everything else and keeps the order within each group", () => {
    const s = [{ kind: "pen", n: 1 }, { kind: "fill", n: 2 }, { kind: "rect", n: 3 }, { kind: "fill", n: 4 }, { kind: "text", n: 5 }];
    expect(renderOrder(s).map((x) => (x as { n: number }).n)).toEqual([2, 4, 1, 3, 5]);
  });
  it("does not change the list it is given and copes with an empty one", () => {
    const s = [{ kind: "pen" }, { kind: "fill" }];
    renderOrder(s);
    expect(s.map((x) => x.kind)).toEqual(["pen", "fill"]);
    expect(renderOrder([])).toEqual([]);
  });
});
