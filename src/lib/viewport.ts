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

export type WheelInput = { ctrlKey: boolean; metaKey: boolean; deltaX: number; deltaY: number; deltaMode: number };
export type WheelAction = { kind: "zoom"; factor: number } | { kind: "pan"; dx: number; dy: number } | { kind: "none" };

/**
 * What a wheel or trackpad event should do. Ctrl or Cmd (a trackpad pinch is sent as Ctrl+wheel)
 * zooms; a plain scroll moves around when zoomed in; when the whole board is visible it does
 * nothing so the page can scroll normally. Deltas are in pixels.
 */
export function wheelAction(e: WheelInput, zoom: number): WheelAction {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1; // lines and pages to pixels
  const dx = e.deltaX * unit, dy = e.deltaY * unit;
  if (e.ctrlKey || e.metaKey) return { kind: "zoom", factor: Math.exp(-Math.max(-2000, Math.min(2000, dy)) * 0.0015) };
  return zoom > 1 ? { kind: "pan", dx, dy } : { kind: "none" };
}
