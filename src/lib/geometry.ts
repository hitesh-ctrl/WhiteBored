import { fontSizeFor } from "../shared/limits";
import type { Point } from "./drawing";

export type Shape = { kind: string; width: number; points: Point[]; text?: string | null };
type Box = { x: number; y: number; w: number; h: number };

const TEXT_WIDTH_PER_EM = 0.6;
const TEXT_HEIGHT_PER_EM = 1.2;
const ELLIPSE_SEGMENTS = 48;

export function textBox(s: Shape): Box {
  const [x, y] = s.points[0];
  const size = fontSizeFor(s.width);
  return { x, y, w: (s.text?.length ?? 1) * size * TEXT_WIDTH_PER_EM, h: size * TEXT_HEIGHT_PER_EM };
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

const minDistToPath = (p: Point, path: Point[]) => {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) best = Math.min(best, distToSegment(p, path[i], path[i + 1]));
  return best;
};

function cornerBox(s: Shape) {
  const [a, b] = s.points;
  return { x1: Math.min(a[0], b[0]), y1: Math.min(a[1], b[1]), x2: Math.max(a[0], b[0]), y2: Math.max(a[1], b[1]) };
}

/** Does a pointer at `p` with eraser `radius` touch this stroke? */
export function strokeHit(s: Shape, p: Point, radius: number): boolean {
  const reach = radius + s.width / 2;
  switch (s.kind) {
    case "text": {
      const b = textBox(s);
      return p[0] >= b.x - radius && p[0] <= b.x + b.w + radius && p[1] >= b.y - radius && p[1] <= b.y + b.h + radius;
    }
    case "rect": {
      const { x1, y1, x2, y2 } = cornerBox(s);
      const outline: Point[] = [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]];
      return minDistToPath(p, outline) <= reach;
    }
    case "ellipse": {
      const { x1, y1, x2, y2 } = cornerBox(s);
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = (x2 - x1) / 2, ry = (y2 - y1) / 2;
      const ring: Point[] = Array.from({ length: ELLIPSE_SEGMENTS + 1 }, (_, i) => {
        const a = (i / ELLIPSE_SEGMENTS) * Math.PI * 2;
        return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
      });
      return minDistToPath(p, ring) <= reach;
    }
    default: // pen, line, arrow
      if (s.points.length === 1) return Math.hypot(p[0] - s.points[0][0], p[1] - s.points[0][1]) <= reach;
      return minDistToPath(p, s.points) <= reach;
  }
}

/** Box around the stroke, padded by half the line width. */
export function strokeBounds(s: Shape): Box {
  if (s.kind === "text") return textBox(s);
  const xs = s.points.map((p) => p[0]);
  const ys = s.points.map((p) => p[1]);
  const pad = s.width / 2;
  const x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
}
