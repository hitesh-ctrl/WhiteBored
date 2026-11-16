import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./limits";

export type Pt = [number, number];
export type Box = { minX: number; minY: number; maxX: number; maxY: number };

const round1 = (n: number) => Math.round(n * 10) / 10;
const finite = (n: number) => (Number.isFinite(n) ? n : 0);

export function pointsBounds(points: Pt[]): Box {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/**
 * The shift that is actually applied to a group whose points lie in `box`: rounded to one
 * decimal and cut off so no point leaves the canvas. The group moves as one, so the strokes
 * keep their positions relative to each other. Used by the browser (preview) and the server.
 */
export function clampDelta(box: Box, dx: number, dy: number): { dx: number; dy: number } {
  return {
    dx: round1(Math.min(CANVAS_WIDTH - box.maxX, Math.max(-box.minX, round1(finite(dx))))),
    dy: round1(Math.min(CANVAS_HEIGHT - box.maxY, Math.max(-box.minY, round1(finite(dy))))),
  };
}

export function translatePoints(points: Pt[], dx: number, dy: number): Pt[] {
  return points.map(([x, y]) => [round1(x + dx), round1(y + dy)]);
}
