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
  it("draws a fill as a polygon and puts it under lines even if it was made later", () => {
    const svg = strokesToSvg([
      { ...base, id: "1", color: "#111111", kind: "rect", points: pt([0, 0], [10, 10]) },
      { ...base, id: "2", color: "#abcdef", kind: "fill", width: 1, points: pt([0, 0], [10, 0], [10, 10], [0, 10]) },
    ]);
    expect(svg).toMatch(/<polygon[^>]*points="0,0 10,0 10,10 0,10"[^>]*fill="#abcdef"/);
    expect(svg.indexOf("#abcdef")).toBeLessThan(svg.indexOf("#111111"));
  });
  it("replaces a malformed fill colour", () => {
    const svg = strokesToSvg([{ ...base, color: 'x" onload="alert(1)', kind: "fill", width: 1, points: pt([0, 0], [1, 0], [1, 1]) }]);
    expect(svg).not.toContain("onload");
    expect(svg).toContain('fill="#000000"');
  });

  const jpegHref = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  it("puts pictures under everything else, with their position, size and opacity", () => {
    const svg = strokesToSvg(
      [{ ...base, id: "1", color: "#111111", kind: "line", points: pt([0, 0], [1, 1]) }],
      [{ x: 10, y: 20, w: 300, h: 200, opacity: 40, href: jpegHref }],
    );
    expect(svg).toMatch(/<image[^>]*x="10"[^>]*y="20"[^>]*width="300"[^>]*height="200"[^>]*opacity="0.4"/);
    expect(svg).toContain(`href="${jpegHref}"`);
    expect(svg.indexOf("<image")).toBeLessThan(svg.indexOf("#111111"));
  });
  it("draws a built-in picture as an outline path scaled into its box", () => {
    const svg = strokesToSvg([], [{ x: 100, y: 50, w: 200, h: 200, opacity: 60, template: "heart" }]);
    expect(svg).toMatch(/<g[^>]*transform="translate\(100 50\) scale\(2 2\)"[^>]*opacity="0.6"/);
    expect(svg).toMatch(/<path[^>]*d="M50 90/);
    expect(svg).toContain('fill="none"');
  });
  it("skips a picture whose data is not a plain base64 picture, and a template it does not know", () => {
    const bad = [
      'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGI+', 'javascript:alert(1)', 'https://evil.example/x.png',
      'data:image/png;base64,AAAA" onload="alert(1)', "",
    ];
    for (const href of bad) expect(strokesToSvg([], [{ x: 0, y: 0, w: 10, h: 10, opacity: 50, href }])).not.toContain("<image");
    const svg = strokesToSvg([], [{ x: 0, y: 0, w: 10, h: 10, opacity: 50, template: "dragon" as never }]);
    expect(svg).not.toContain("<g");
  });
  it("writes only numbers into the position, size and opacity", () => {
    const svg = strokesToSvg([], [{ x: NaN, y: Infinity, w: 10, h: 10, opacity: 50, href: jpegHref }]);
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("Infinity");
  });
});
