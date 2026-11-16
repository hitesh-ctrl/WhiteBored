/**
 * Built-in pictures to trace: simple outlines drawn as vector paths in a 100 by 100 box. They are
 * drawn by the browser, so nothing is uploaded or stored but the key. Paths use plain path commands only.
 */
export const TEMPLATES = [
  { key: "house", label: "House", path: "M10 50 L50 15 L90 50 M20 45 V88 H80 V45 M42 88 V62 H58 V88 M66 28 V18 H76 V36" },
  { key: "tree", label: "Tree", path: "M50 6 C24 6 14 32 32 42 C12 50 22 76 42 70 L42 94 H58 L58 70 C78 76 88 50 68 42 C86 32 76 6 50 6 Z" },
  { key: "cat", label: "Cat", path: "M22 40 L22 12 L42 28 H58 L78 12 V40 C88 54 82 78 50 86 C18 78 12 54 22 40 Z M36 50 L40 54 M64 50 L60 54 M45 64 L50 69 L55 64 M50 69 V75 M30 62 H10 M30 68 L12 77 M70 62 H90 M70 68 L88 77" },
  { key: "face", label: "Face", path: "M50 8 A42 42 0 1 1 49.9 8 Z M34 38 A5 5 0 1 1 33.9 38 Z M66 38 A5 5 0 1 1 65.9 38 Z M26 60 C36 80 64 80 74 60" },
  { key: "heart", label: "Heart", path: "M50 90 C8 58 4 30 24 17 C38 9 50 21 50 30 C50 21 62 9 76 17 C96 30 92 58 50 90 Z" },
  { key: "star", label: "Star", path: "M50 6 L61 38 L95 38 L67 58 L78 92 L50 71 L22 92 L33 58 L5 38 L39 38 Z" },
  { key: "grid", label: "Grid", path: "M0 0 H100 V100 H0 Z M33 0 V100 M66 0 V100 M0 33 H100 M0 66 H100" },
] as const;

export const TEMPLATE_KEYS = ["house", "tree", "cat", "face", "heart", "star", "grid"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const isTemplateKey = (k: unknown): k is TemplateKey =>
  typeof k === "string" && (TEMPLATE_KEYS as readonly string[]).includes(k);
