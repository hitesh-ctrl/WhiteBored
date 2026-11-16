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
