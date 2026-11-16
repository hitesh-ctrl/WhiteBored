import type { Point } from "./drawing";
import { MAX_POINTS_PER_STROKE } from "../shared/limits";

export type FillSource = { kind: string; width: number; points: Point[] };

const ELLIPSE_SEGMENTS = 48;
const CLOSE_TOLERANCE = 20; // a pen path counts as closed when its end comes back within this distance of its start
const MIN_LOOP_AREA = 100; // ignores tiny scribbles whose end happens to be near their start
const round1 = (n: number) => Math.round(n * 10) / 10;

const area = (poly: Point[]) => {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
};

/** The outline of a stroke as a polygon, if it encloses an area: rectangles, ellipses and closed pen loops. */
export function closedPolygon(s: FillSource): Point[] | null {
  const [a, b] = s.points;
  switch (s.kind) {
    case "rect": {
      if (!b) return null;
      const x1 = Math.min(a[0], b[0]), y1 = Math.min(a[1], b[1]), x2 = Math.max(a[0], b[0]), y2 = Math.max(a[1], b[1]);
      return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
    }
    case "ellipse": {
      if (!b) return null;
      const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, rx = Math.abs(b[0] - a[0]) / 2, ry = Math.abs(b[1] - a[1]) / 2;
      return Array.from({ length: ELLIPSE_SEGMENTS }, (_, i) => {
        const t = (i / ELLIPSE_SEGMENTS) * Math.PI * 2;
        return [round1(cx + rx * Math.cos(t)), round1(cy + ry * Math.sin(t))] as Point;
      });
    }
    case "pen": {
      if (s.points.length < 3) return null;
      const last = s.points[s.points.length - 1];
      if (Math.hypot(last[0] - a[0], last[1] - a[1]) > Math.max(CLOSE_TOLERANCE, s.width * 3)) return null;
      return area(s.points) >= MIN_LOOP_AREA ? [...s.points] : null;
    }
    default:
      return null;
  }
}

/** Even-odd test, so it also works for shapes that are not convex. */
export function pointInPolygon(p: Point, poly: Point[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The closed shape to fill when the person clicks at `p`: the one drawn last that contains the point. */
export function findFillContainer(strokes: (FillSource & { id: string })[], p: Point): { id: string; polygon: Point[] } | null {
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (strokes[i].kind === "fill") continue;
    const polygon = closedPolygon(strokes[i]);
    if (polygon && polygon.length <= MAX_POINTS_PER_STROKE && pointInPolygon(p, polygon)) return { id: strokes[i].id, polygon };
  }
  return null;
}

/** Just the polygon of the shape under the point. */
export function findFillTarget(strokes: FillSource[], p: Point): Point[] | null {
  return findFillContainer(strokes.map((s, i) => ({ ...s, id: String(i) })), p)?.polygon ?? null;
}
