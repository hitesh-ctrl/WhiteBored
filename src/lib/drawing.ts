import { CANVAS_HEIGHT, CANVAS_WIDTH, MAX_POINTS_PER_BATCH } from "../shared/limits";

export type Point = [number, number];
export type RectLike = { left: number; top: number; width: number; height: number };

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, max: number) => Math.min(max, Math.max(0, n));

/** Map screen coordinates to the logical canvas: scaled, rounded to 1 decimal, clamped. */
export function toCanvasPoint(clientX: number, clientY: number, rect: RectLike): Point {
  if (rect.width <= 0 || rect.height <= 0) return [0, 0];
  const x = ((clientX - rect.left) / rect.width) * CANVAS_WIDTH;
  const y = ((clientY - rect.top) / rect.height) * CANVAS_HEIGHT;
  return [clamp(round1(x), CANVAS_WIDTH), clamp(round1(y), CANVAS_HEIGHT)];
}

/** Skip points closer than `minDistance` to the previous one. */
export function shouldAddPoint(prev: Point | undefined, next: Point, minDistance = 1): boolean {
  if (!prev) return true;
  return Math.hypot(next[0] - prev[0], next[1] - prev[1]) >= minDistance;
}

/**
 * Next progress batch. `sent` is how many points were already sent. Each batch
 * starts with the last point of the previous one so lines have no gaps.
 */
export function nextBatch(
  points: Point[],
  sent: number,
  max = MAX_POINTS_PER_BATCH,
): { batch: Point[]; sent: number } | null {
  if (sent >= points.length) return null;
  const start = Math.max(sent - 1, 0);
  const end = Math.min(points.length, start + max);
  return { batch: points.slice(start, end), sent: end };
}

export function ownStrokeIds(strokes: { id: string; authorId: string }[], clientId: string): string[] {
  return strokes.filter((s) => s.authorId === clientId).map((s) => s.id);
}
