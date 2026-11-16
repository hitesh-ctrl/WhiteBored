import { describe, expect, it } from "vitest";
import { DEFAULT_VIEW, clampView, panBy, screenToCanvas, zoomAt } from "../src/lib/viewport";

describe("viewport", () => {
  it("maps the middle of an unzoomed view to the middle of the canvas", () => {
    expect(screenToCanvas(DEFAULT_VIEW, 0.5, 0.5)).toEqual([800, 450]);
  });
  it("maps through zoom and pan", () => {
    expect(screenToCanvas({ zoom: 2, panX: 400, panY: 225 }, 0, 0)).toEqual([400, 225]);
    expect(screenToCanvas({ zoom: 2, panX: 400, panY: 225 }, 1, 1)).toEqual([1200, 675]);
  });
  it("zooming keeps the point under the pointer still", () => {
    const v = zoomAt(DEFAULT_VIEW, 2, [800, 450]);
    expect(v.zoom).toBe(2);
    const p = screenToCanvas(v, 0.5, 0.5);
    expect(p[0]).toBeCloseTo(800);
    expect(p[1]).toBeCloseTo(450);
  });
  it("zooming at a corner keeps the corner", () => {
    expect(zoomAt(DEFAULT_VIEW, 2, [0, 0])).toEqual({ zoom: 2, panX: 0, panY: 0 });
  });
  it("limits the zoom to 1..8", () => {
    expect(zoomAt(DEFAULT_VIEW, 100, [10, 10]).zoom).toBe(8);
    expect(zoomAt(DEFAULT_VIEW, 0.1, [10, 10]).zoom).toBe(1);
  });
  it("never shows area outside the canvas", () => {
    expect(clampView({ zoom: 2, panX: -50, panY: 9999 })).toEqual({ zoom: 2, panX: 0, panY: 450 });
    expect(clampView({ zoom: 1, panX: 300, panY: 300 })).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });
  it("pans by a fraction of the visible area, clamped", () => {
    expect(panBy({ zoom: 2, panX: 0, panY: 0 }, 0.5, 0)).toEqual({ zoom: 2, panX: 400, panY: 0 });
    expect(panBy({ zoom: 2, panX: 700, panY: 0 }, 1, 0).panX).toBe(800);
  });
});

import { wheelAction } from "../src/lib/viewport";

describe("wheelAction", () => {
  const base = { ctrlKey: false, metaKey: false, deltaX: 0, deltaY: 0, deltaMode: 0 };
  it("zooms with Ctrl or Cmd held, which is also what a trackpad pinch sends, at any zoom level", () => {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      for (const zoom of [1, 3]) {
        const a = wheelAction({ ...base, ...mod, deltaY: -100 }, zoom);
        expect(a.kind).toBe("zoom");
        expect((a as { factor: number }).factor).toBeCloseTo(Math.exp(0.15));
      }
    }
    expect((wheelAction({ ...base, ctrlKey: true, deltaY: 100 }, 1) as { factor: number }).factor).toBeLessThan(1);
  });
  it("pans with a plain wheel or two-finger scroll when zoomed in", () => {
    expect(wheelAction({ ...base, deltaX: 30, deltaY: -40 }, 2)).toEqual({ kind: "pan", dx: 30, dy: -40 });
  });
  it("does nothing, and so lets the page scroll, when the whole board is visible", () => {
    expect(wheelAction({ ...base, deltaY: 100 }, 1)).toEqual({ kind: "none" });
  });
  it("turns line and page scrolling (Firefox) into pixels", () => {
    expect(wheelAction({ ...base, deltaY: 3, deltaMode: 1 }, 2)).toEqual({ kind: "pan", dx: 0, dy: 48 });
    expect(wheelAction({ ...base, deltaY: 1, deltaMode: 2 }, 2)).toEqual({ kind: "pan", dx: 0, dy: 100 });
    expect((wheelAction({ ...base, ctrlKey: true, deltaY: 3, deltaMode: 1 }, 1) as { factor: number }).factor).toBeCloseTo(Math.exp(-48 * 0.0015));
  });
  it("never produces NaN or infinite values", () => {
    const a = wheelAction({ ...base, ctrlKey: true, deltaY: 1e9 }, 1) as { factor: number };
    expect(Number.isFinite(a.factor)).toBe(true);
    expect(a.factor).toBeGreaterThan(0);
  });
});
