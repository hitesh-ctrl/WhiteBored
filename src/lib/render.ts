import { fontSizeFor } from "../shared/limits";
import type { Point } from "./drawing";

export type Drawable = { kind: string; color: string; width: number; points: Point[]; text?: string | null };

/** Draw one stroke of any kind. Used for the live canvas and for the PNG export. */
export function drawStroke(ctx: CanvasRenderingContext2D, s: Drawable) {
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const [a, b] = s.points;
  if (!a) return;

  switch (s.kind) {
    case "text":
      ctx.font = `${fontSizeFor(s.width)}px sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(s.text ?? "", a[0], a[1]);
      return;
    case "line":
    case "arrow": {
      if (!b) return;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      if (s.kind === "arrow") {
        const head = Math.max(12, s.width * 4);
        const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
        ctx.beginPath();
        ctx.moveTo(b[0] - head * Math.cos(angle + Math.PI / 6), b[1] - head * Math.sin(angle + Math.PI / 6));
        ctx.lineTo(b[0], b[1]);
        ctx.lineTo(b[0] - head * Math.cos(angle - Math.PI / 6), b[1] - head * Math.sin(angle - Math.PI / 6));
        ctx.stroke();
      }
      return;
    }
    case "rect":
      if (b) ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      return;
    case "ellipse":
      if (b) {
        ctx.beginPath();
        ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      return;
    default: {
      if (s.points.length === 1) {
        ctx.beginPath();
        ctx.arc(a[0], a[1], s.width / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      for (const p of s.points.slice(1)) ctx.lineTo(p[0], p[1]);
      ctx.stroke();
    }
  }
}

/** A file name that is safe on every system and never empty. */
export function safeFileName(name: string, ext: string): string {
  const base = name.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${base || "board"}.${ext}`;
}
