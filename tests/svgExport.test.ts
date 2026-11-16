import { describe, expect, it } from "vitest";
import { strokesToSvg } from "../src/lib/svgExport";

const base = { id: "i", authorId: "a", color: "#112233", width: 4 };
const pt = (...p: number[][]) => p as [number, number][];

describe("strokesToSvg", () => {
  it("makes a 1600x900 svg with a white background", () => {
    const svg = strokesToSvg([]);
    expect(svg).toContain('viewBox="0 0 1600 900"');
    expect(svg).toContain('width="1600"');
    expect(svg).toMatch(/<rect[^>]*fill="#ffffff"/);
  });
  it("draws a pen stroke as a rounded polyline with its colour and width", () => {
    const svg = strokesToSvg([{ ...base, kind: "pen", points: pt([1, 2], [3, 4], [5, 6]) }]);
    expect(svg).toContain('points="1,2 3,4 5,6"');
    expect(svg).toContain('stroke="#112233"');
    expect(svg).toContain('stroke-width="4"');
    expect(svg).toContain('stroke-linecap="round"');
  });
  it("draws a single-point pen stroke as a dot", () => {
    expect(strokesToSvg([{ ...base, kind: "pen", points: pt([10, 20]) }])).toMatch(/<circle[^>]*cx="10"[^>]*cy="20"/);
  });
  it("draws line, rect, ellipse and arrow", () => {
    const two = pt([100, 100], [300, 200]);
    expect(strokesToSvg([{ ...base, kind: "line", points: two }])).toMatch(/<line[^>]*x1="100"[^>]*y2="200"/);
    expect(strokesToSvg([{ ...base, kind: "rect", points: pt([300, 200], [100, 100]) }])).toMatch(/<rect[^>]*x="100"[^>]*y="100"[^>]*width="200"[^>]*height="100"/);
    expect(strokesToSvg([{ ...base, kind: "ellipse", points: two }])).toMatch(/<ellipse[^>]*cx="200"[^>]*cy="150"[^>]*rx="100"[^>]*ry="50"/);
    const arrow = strokesToSvg([{ ...base, kind: "arrow", points: two }]);
    expect(arrow).toContain("<line");
    expect(arrow).toContain("<polyline"); // the head
  });
  it("draws text with the design's font size", () => {
    const svg = strokesToSvg([{ ...base, kind: "text", text: "Hi", points: pt([50, 60]) }]);
    expect(svg).toMatch(/<text[^>]*x="50"[^>]*font-size="16"/);
    expect(svg).toContain(">Hi</text>");
  });
  it("escapes text so it cannot add elements or attributes", () => {
    const svg = strokesToSvg([{ ...base, kind: "text", text: `<script>alert(1)</script> & "q" 'r'`, points: pt([1, 1]) }]);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;");
  });
  it("replaces a malformed colour instead of writing it into an attribute", () => {
    const svg = strokesToSvg([{ ...base, color: 'red" onload="alert(1)', kind: "line", points: pt([0, 0], [1, 1]) }]);
    expect(svg).not.toContain("onload");
    expect(svg).toContain('stroke="#000000"');
  });
  it("keeps draw order", () => {
    const svg = strokesToSvg([
      { ...base, id: "1", color: "#111111", kind: "line", points: pt([0, 0], [1, 1]) },
      { ...base, id: "2", color: "#222222", kind: "line", points: pt([0, 0], [1, 1]) },
    ]);
    expect(svg.indexOf("#111111")).toBeLessThan(svg.indexOf("#222222"));
  });
});
