import type { Point } from "./drawing";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../shared/limits";

export type Rect = { x: number; y: number; w: number; h: number };

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export const MIN_IMAGE_SIDE = 40;
export const MAX_IMAGE_SIDE_ON_BOARD = 3200;

/** Where a new picture goes: centred, the same shape as the picture, using up to 70% of the board. */
export function fitRect(naturalW: number, naturalH: number): Rect {
  const nw = naturalW > 0 ? naturalW : 100, nh = naturalH > 0 ? naturalH : 100;
  const scale = Math.min((CANVAS_WIDTH * 0.7) / nw, (CANVAS_HEIGHT * 0.7) / nh);
  const w = nw * scale, h = nh * scale;
  return { x: round1((CANVAS_WIDTH - w) / 2), y: round1((CANVAS_HEIGHT - h) / 2), w: round1(w), h: round1(h) };
}

/** Change the width and keep the shape; the top left corner stays where it is. */
export function resizeKeepAspect(r: Rect, newW: number): Rect {
  if (!Number.isFinite(newW) || r.w <= 0) return r;
  let w = clamp(newW, MIN_IMAGE_SIDE, MAX_IMAGE_SIDE_ON_BOARD);
  let h = (r.h * w) / r.w;
  if (h > MAX_IMAGE_SIDE_ON_BOARD) {
    h = MAX_IMAGE_SIDE_ON_BOARD;
    w = (r.w * h) / r.h;
  }
  return { x: r.x, y: r.y, w, h };
}

export function rectContains(r: Rect, p: Point): boolean {
  return p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.h;
}

/** The resize handle is the bottom right corner. */
export function onHandle(r: Rect, p: Point, radius: number): boolean {
  return Math.hypot(p[0] - (r.x + r.w), p[1] - (r.y + r.h)) <= radius;
}

/** The ranges the server accepts, rounded to one decimal. */
export function clampImageRect(r: Rect): Rect {
  return {
    x: round1(clamp(r.x, -800, 2400)),
    y: round1(clamp(r.y, -450, 1350)),
    w: round1(clamp(r.w, 20, 3200)),
    h: round1(clamp(r.h, 20, 3200)),
  };
}
