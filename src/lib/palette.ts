/** The colour swatches, in the order they are shown. Names are for screen readers and tests. */
export const PALETTE: readonly (readonly [string, string])[] = [
  ["Black", "#111827"], ["Dark gray", "#4b5563"], ["Gray", "#9ca3af"], ["Light gray", "#e5e7eb"], ["White", "#ffffff"],
  ["Brown", "#92400e"], ["Dark red", "#7f1d1d"], ["Red", "#dc2626"], ["Salmon", "#fca5a5"], ["Rose", "#fb7185"],
  ["Pink", "#db2777"], ["Magenta", "#d946ef"], ["Purple", "#7c3aed"], ["Violet", "#a78bfa"], ["Indigo", "#4f46e5"],
  ["Navy", "#1e3a8a"], ["Blue", "#2563eb"], ["Sky", "#38bdf8"], ["Cyan", "#06b6d4"], ["Teal", "#0d9488"],
  ["Dark green", "#166534"], ["Green", "#16a34a"], ["Lime", "#84cc16"], ["Yellow", "#ca8a04"], ["Bright yellow", "#facc15"],
  ["Orange", "#ea580c"], ["Light orange", "#fdba74"], ["Beige", "#e7d3b0"],
];
const MAX_RECENT = 8;
const inPalette = (hex: string) => PALETTE.some((c) => c[1] === hex);

/** A colour as #rrggbb in lower case, from six digits (with or without #) or three; null for anything else. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(v)) return `#${v.toLowerCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(v)) return `#${[...v.toLowerCase()].map((c) => c + c).join("")}`;
  return null;
}

/** Custom colours the person picked, newest first. Colours already in the palette are not repeated here. */
export function rememberColor(list: string[], hex: string): string[] {
  const n = normalizeHex(hex);
  if (!n || inPalette(n)) return [...list];
  return [n, ...list.filter((c) => c !== n)].slice(0, MAX_RECENT);
}

/** Storage can hold anything, so every entry is checked before it is shown or used. */
export function parseRecentColors(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const out: string[] = [];
    for (const item of data) {
      const n = normalizeHex(item);
      if (n && !out.includes(n)) out.push(n);
    }
    return out.slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}
