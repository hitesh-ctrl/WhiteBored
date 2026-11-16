import { CANVAS_HEIGHT, CANVAS_WIDTH, fontSizeFor } from "../shared/limits";
import type { Point } from "./drawing";
import { renderOrder } from "./render";
import { TEMPLATES } from "../shared/templates";

export type ExportStroke = { id?: string; authorId?: string; kind: string; color: string; width: number; points: Point[]; text?: string | null };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const n = (v: number) => String(Math.round(v * 10) / 10);
const safeColor = (c: string) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c : "#000000");

function element(s: ExportStroke): string {
  const color = safeColor(s.color);
  const line = `fill="none" stroke="${color}" stroke-width="${n(s.width)}" stroke-linecap="round" stroke-linejoin="round"`;
  const [a, b] = s.points;
  switch (s.kind) {
    case "fill":
      return `<polygon points="${s.points.map((p) => `${n(p[0])},${n(p[1])}`).join(" ")}" fill="${color}"/>`;
    case "text": {
      const size = fontSizeFor(s.width);
      return `<text x="${n(a[0])}" y="${n(a[1] + size)}" font-size="${size}" font-family="sans-serif" fill="${color}">${esc(s.text ?? "")}</text>`;
    }
    case "line":
      return `<line x1="${n(a[0])}" y1="${n(a[1])}" x2="${n(b[0])}" y2="${n(b[1])}" ${line}/>`;
    case "arrow": {
      const head = Math.max(12, s.width * 4);
      const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const side = (d: number): Point => [b[0] - head * Math.cos(angle + d), b[1] - head * Math.sin(angle + d)];
      const l = side(Math.PI / 6), r = side(-Math.PI / 6);
      return (
        `<line x1="${n(a[0])}" y1="${n(a[1])}" x2="${n(b[0])}" y2="${n(b[1])}" ${line}/>` +
        `<polyline points="${n(l[0])},${n(l[1])} ${n(b[0])},${n(b[1])} ${n(r[0])},${n(r[1])}" ${line}/>`
      );
    }
    case "rect": {
      const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
      return `<rect x="${n(x)}" y="${n(y)}" width="${n(Math.abs(b[0] - a[0]))}" height="${n(Math.abs(b[1] - a[1]))}" ${line}/>`;
    }
    case "ellipse":
      return `<ellipse cx="${n((a[0] + b[0]) / 2)}" cy="${n((a[1] + b[1]) / 2)}" rx="${n(Math.abs(b[0] - a[0]) / 2)}" ry="${n(Math.abs(b[1] - a[1]) / 2)}" ${line}/>`;
    default:
      if (s.points.length === 1) return `<circle cx="${n(a[0])}" cy="${n(a[1])}" r="${n(s.width / 2)}" fill="${color}"/>`;
      return `<polyline points="${s.points.map((p) => `${n(p[0])},${n(p[1])}`).join(" ")}" ${line}/>`;
  }
}

/** A picture under the drawing: an uploaded one as a data address, or a built-in outline by key. */
export type ExportImage = { x: number; y: number; w: number; h: number; opacity: number; href?: string; template?: string };

const DATA_PICTURE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

function pictureElement(p: ExportImage): string {
  if (![p.x, p.y, p.w, p.h, p.opacity].every(Number.isFinite)) return "";
  const opacity = Math.min(100, Math.max(5, Math.round(p.opacity))) / 100;
  if (p.href !== undefined) {
    if (!DATA_PICTURE.test(p.href)) return "";
    return `<image x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}" opacity="${opacity}" href="${p.href}" preserveAspectRatio="none"/>`;
  }
  const template = TEMPLATES.find((t) => t.key === p.template);
  if (!template) return "";
  const thin = n((2.5 * 100) / Math.max(1, Math.min(p.w, p.h)));
  return `<g transform="translate(${n(p.x)} ${n(p.y)}) scale(${n(p.w / 100)} ${n(p.h / 100)})" opacity="${opacity}" fill="none" stroke="#475569" stroke-width="${thin}" stroke-linecap="round" stroke-linejoin="round"><path d="${template.path}"/></g>`;
}

/** The whole board as a standalone SVG file. Only validated values are written into attributes. */
export function strokesToSvg(strokes: ExportStroke[], images: ExportImage[] = []): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}">` +
    `<rect width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" fill="#ffffff"/>` +
    images.map(pictureElement).join("") +
    renderOrder(strokes).map(element).join("") +
    `</svg>`
  );
}
