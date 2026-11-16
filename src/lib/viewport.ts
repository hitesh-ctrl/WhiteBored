import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../shared/limits";

/** The visible part of the canvas: top-left corner in canvas units and a zoom factor. */
export type View = { zoom: number; panX: number; panY: number };
export const DEFAULT_VIEW: View = { zoom: 1, panX: 0, panY: 0 };
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

const norm = (n: number) => n || 0; // turns -0 into 0
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Canvas coordinates of a point given as a fraction (0..1) of the displayed area. */
export function screenToCanvas(v: View, fx: number, fy: number): [number, number] {
  return [v.panX + (fx * CANVAS_WIDTH) / v.zoom, v.panY + (fy * CANVAS_HEIGHT) / v.zoom];
}

export function clampView(v: View): View {
  const zoom = clamp(v.zoom, MIN_ZOOM, MAX_ZOOM);
  return {
    zoom,
    panX: norm(clamp(v.panX, 0, CANVAS_WIDTH - CANVAS_WIDTH / zoom)),
    panY: norm(clamp(v.panY, 0, CANVAS_HEIGHT - CANVAS_HEIGHT / zoom)),
  };
}

/** Zoom so that the canvas point `anchor` stays where it is on screen. */
export function zoomAt(v: View, newZoom: number, anchor: [number, number]): View {
  const zoom = clamp(newZoom, MIN_ZOOM, MAX_ZOOM);
  const fx = (anchor[0] - v.panX) / (CANVAS_WIDTH / v.zoom);
  const fy = (anchor[1] - v.panY) / (CANVAS_HEIGHT / v.zoom);
  return clampView({
    zoom,
    panX: anchor[0] - (fx * CANVAS_WIDTH) / zoom,
    panY: anchor[1] - (fy * CANVAS_HEIGHT) / zoom,
  });
}

/** Move by a fraction of the visible area. */
export function panBy(v: View, dx: number, dy: number): View {
  return clampView({ ...v, panX: v.panX + (dx * CANVAS_WIDTH) / v.zoom, panY: v.panY + (dy * CANVAS_HEIGHT) / v.zoom });
}
