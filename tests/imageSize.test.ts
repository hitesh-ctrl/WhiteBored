import { describe, expect, it } from "vitest";
import { checkImage, imageSize, sniffMime } from "../src/shared/images";
import { MAX_IMAGE_BYTES } from "../src/shared/limits";
import { gif, jpeg, png, svg, webpL, webpV, webpX } from "./imageFixtures";

describe("sniffMime (the type comes from the first bytes, not from a name or a claim)", () => {
  it("recognises PNG, JPEG and WebP", () => {
    expect(sniffMime(png(1, 1))).toBe("image/png");
    expect(sniffMime(jpeg(1, 1))).toBe("image/jpeg");
    expect(sniffMime(webpX(1, 1))).toBe("image/webp");
  });
  it("refuses GIF, SVG text, scripts, empty and too-short data", () => {
    for (const b of [gif(), svg(), Buffer.from("<html>"), Buffer.alloc(0), Buffer.from([0x89, 0x50]), Buffer.from("RIFFxxxxWAVE....")]) expect(sniffMime(b)).toBeNull();
  });
});

describe("imageSize (read from the file's own header)", () => {
  it("reads PNG", () => expect(imageSize(png(800, 600), "image/png")).toEqual({ width: 800, height: 600 }));
  it("reads JPEG, skipping the segments before the frame header", () => expect(imageSize(jpeg(1024, 768), "image/jpeg")).toEqual({ width: 1024, height: 768 }));
  it("reads all three WebP layouts", () => {
    expect(imageSize(webpX(640, 480), "image/webp")).toEqual({ width: 640, height: 480 });
    expect(imageSize(webpL(321, 123), "image/webp")).toEqual({ width: 321, height: 123 });
    expect(imageSize(webpV(500, 250), "image/webp")).toEqual({ width: 500, height: 250 });
  });
  it("reports huge claimed sizes as they are, so they can be refused", () => {
    expect(imageSize(png(60000, 60000), "image/png")).toEqual({ width: 60000, height: 60000 });
    expect(imageSize(jpeg(65535, 65535), "image/jpeg")).toEqual({ width: 65535, height: 65535 });
  });
  it("returns null for truncated or malformed headers", () => {
    expect(imageSize(png(10, 10).subarray(0, 20), "image/png")).toBeNull();
    expect(imageSize(jpeg(10, 10).subarray(0, 12), "image/jpeg")).toBeNull();
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg")).toBeNull(); // no frame header
    expect(imageSize(webpX(10, 10).subarray(0, 24), "image/webp")).toBeNull();
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0x12, 0x34]), "image/jpeg")).toBeNull();
  });
  it("does not loop forever on a JPEG made of tiny segments", () => {
    const b = Buffer.concat([Buffer.from([0xff, 0xd8]), ...Array.from({ length: 2000 }, () => Buffer.from([0xff, 0xe1, 0x00, 0x02]))]);
    expect(imageSize(b, "image/jpeg")).toBeNull();
  });
});

describe("checkImage", () => {
  it("accepts a normal picture and returns what it found", () => {
    expect(checkImage(jpeg(1200, 800, 5000))).toEqual({ ok: true, mime: "image/jpeg", width: 1200, height: 800 });
    expect(checkImage(png(4096, 1000))).toMatchObject({ ok: true, mime: "image/png" });
  });
  it("refuses a file over the size limit", () => {
    expect(checkImage(png(100, 100, MAX_IMAGE_BYTES + 1)).ok).toBe(false);
    expect(checkImage(png(100, 100, MAX_IMAGE_BYTES)).ok).toBe(true);
  });
  it("refuses types that are not allowed, including a script that claims to be an image", () => {
    for (const b of [gif(), svg(), Buffer.from("not an image at all")]) expect(checkImage(b).ok).toBe(false);
  });
  it("refuses a picture that is too wide, too tall, too big in pixels, or has no size", () => {
    expect(checkImage(png(4097, 10)).ok).toBe(false);
    expect(checkImage(png(10, 4097)).ok).toBe(false);
    expect(checkImage(png(4000, 3000)).ok).toBe(false); // 12 million pixels
    expect(checkImage(png(0, 10)).ok).toBe(false);
    expect(checkImage(png(10, 0)).ok).toBe(false);
    expect(checkImage(png(60000, 60000, 100)).ok).toBe(false); // a tiny file that claims a huge picture
    expect(checkImage(png(10, 10).subarray(0, 20)).ok).toBe(false);
  });
  it("accepts the largest allowed picture", () => {
    expect(checkImage(png(4096, 1953)).ok).toBe(true); // just under 8 million pixels
  });
});
