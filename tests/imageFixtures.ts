/** Byte strings that start like real image files. Only headers are built: the server reads headers, never decodes pixels. */
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16be = (n: number) => [(n >> 8) & 255, n & 255];
const u16le = (n: number) => [n & 255, (n >> 8) & 255];
const u24le = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const u32le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const pad = (bytes: number[], total: number) => Buffer.from([...bytes, ...new Array(Math.max(0, total - bytes.length)).fill(0)]);

export const png = (w: number, h: number, total = 0) =>
  pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...ascii("IHDR"), ...u32be(w), ...u32be(h), 8, 2, 0, 0, 0, 0, 0, 0, 0], total);

export const jpeg = (w: number, h: number, total = 0) =>
  pad([
    0xff, 0xd8,
    0xff, 0xe0, ...u16be(16), ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, ...u16be(17), 8, ...u16be(h), ...u16be(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xd9,
  ], total);

export const webpX = (w: number, h: number, total = 0) =>
  pad([...ascii("RIFF"), ...u32le(22), ...ascii("WEBP"), ...ascii("VP8X"), ...u32le(10), 0, 0, 0, 0, ...u24le(w - 1), ...u24le(h - 1)], total);

export const webpL = (w: number, h: number, total = 0) =>
  pad([...ascii("RIFF"), ...u32le(16), ...ascii("WEBP"), ...ascii("VP8L"), ...u32le(5), 0x2f, ...u32le((w - 1) | ((h - 1) << 14))], total);

export const webpV = (w: number, h: number, total = 0) =>
  pad([...ascii("RIFF"), ...u32le(22), ...ascii("WEBP"), ...ascii("VP8 "), ...u32le(10), 0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(w), ...u16le(h)], total);

export const gif = () => Buffer.from([...ascii("GIF89a"), 1, 0, 1, 0, 0, 0, 0]);
export const svg = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
