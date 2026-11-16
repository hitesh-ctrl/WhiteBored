import type { Point } from "./drawing";
import { strokeBounds, type Shape } from "./geometry";

export type Rect = { x: number; y: number; w: number; h: number };

export function normalizeRect(a: Point, b: Point): Rect {
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
}

/** True when the rectangles share any area or touch. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/** Strokes the filter allows whose box overlaps the rectangle. */
export function strokesInRect<T extends Shape & { id: string }>(strokes: T[], rect: Rect, allow: (s: T) => boolean): T[] {
  return strokes.filter((s) => allow(s) && rectsOverlap(strokeBounds(s), rect));
}

/** The box around a whole selection, or null when nothing is selected. */
export function selectionBounds(strokes: Shape[]): Rect | null {
  if (strokes.length === 0) return null;
  const boxes = strokes.map(strokeBounds);
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}
/**
 * A fill belongs to the shape it fills: selecting a shape selects its fills, and selecting a fill
 * selects its shape (and so all of that shape's fills). Only strokes the filter allows are added.
 */
export function expandSelection<T extends { id: string; kind: string; containerId?: string }>(
  strokes: T[],
  selected: Set<string>,
  allow: (s: T) => boolean,
): Set<string> {
  const out = new Set(selected);
  for (const s of strokes) {
    if (!out.has(s.id) || s.kind !== "fill" || !s.containerId) continue;
    const container = strokes.find((x) => x.id === s.containerId);
    if (container && allow(container)) out.add(container.id);
  }
  for (const s of strokes) {
    if (s.kind === "fill" && s.containerId && out.has(s.containerId) && allow(s)) out.add(s.id);
  }
  return out;
}
