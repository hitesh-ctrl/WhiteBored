import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE } from "./limits";

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";
export type ImageCheck = { ok: true; mime: ImageMime; width: number; height: number } | { ok: false; reason: string };

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u32le = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

/** The type of a picture, taken from the first bytes of the file. A name or a claimed type is never trusted. */
export function sniffMime(b: Uint8Array): ImageMime | null {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Width and height as the file's own header states them, or null when the header is cut off or not understood. */
export function imageSize(b: Uint8Array, mime: ImageMime): { width: number; height: number } | null {
  if (mime === "image/png") {
    if (b.length < 24 || ascii(b, 12, 16) !== "IHDR") return null;
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (mime === "image/webp") {
    const kind = b.length >= 16 ? ascii(b, 12, 16) : "";
    if (kind === "VP8X" && b.length >= 30) return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
    if (kind === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
      const v = u32le(b, 21);
      return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8 " && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    }
    return null;
  }
  // JPEG: walk the segments until the frame header, which holds the size
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) { i++; marker = b[i + 1]; } // padding bytes
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; } // markers without a length
    if (marker === 0xd9 || marker === 0xda) return null; // image data or end reached with no frame header
    const length = u16be(b, i + 2);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (i + 9 > b.length) return null;
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

/** Everything the server checks about an uploaded picture before keeping it. */
export function checkImage(b: Uint8Array): ImageCheck {
  if (b.length > MAX_IMAGE_BYTES) return { ok: false, reason: "too large" };
  const mime = sniffMime(b);
  if (!mime) return { ok: false, reason: "type not allowed" };
  const size = imageSize(b, mime);
  if (!size) return { ok: false, reason: "size unreadable" };
  const { width, height } = size;
  if (width < 1 || height < 1) return { ok: false, reason: "empty picture" };
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) return { ok: false, reason: "too many pixels on a side" };
  if (width * height > MAX_IMAGE_PIXELS) return { ok: false, reason: "too many pixels" };
  return { ok: true, mime, width, height };
}
