import { MAX_IMAGE_BYTES } from "../shared/limits";

const MAX_SIDE_SENT = 1600;
const MAX_FILE_BYTES = 20 * 1024 * 1024; // refuse to even decode something enormous
export class UploadError extends Error {}

/** The size to draw a picture at: the longer side at most `maxSide`, the shape kept, at least 1 pixel. */
export function scaledSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const w = Number.isFinite(width) && width > 0 ? width : 1;
  const h = Number.isFinite(height) && height > 0 ? height : 1;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * Turn a chosen file into a small JPEG: decoded by the browser, drawn onto a white canvas and
 * encoded again (which also drops metadata such as the camera's location), shrunk until it fits
 * the size limit. Only JPEG, PNG and WebP are accepted.
 */
export async function prepareUpload(file: File): Promise<{ bytes: Uint8Array<ArrayBuffer>; width: number; height: number }> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new UploadError("Choose a JPEG, PNG or WebP picture.");
  if (file.size > MAX_FILE_BYTES) throw new UploadError("That file is too large. Choose one under 20 MB.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new UploadError("That file could not be read as a picture.");
  }
  let { width, height } = scaledSize(bitmap.width, bitmap.height, MAX_SIDE_SENT);
  let quality = 0.85;
  for (let attempt = 0; attempt < 10; attempt++) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, width, height);
    g.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size <= MAX_IMAGE_BYTES - 1024) {
      bitmap.close();
      return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
    }
    if (quality > 0.5) quality -= 0.15;
    else ({ width, height } = scaledSize(width * 0.8, height * 0.8, MAX_SIDE_SENT));
  }
  bitmap.close();
  throw new UploadError("That picture is too detailed to shrink enough. Try a smaller one.");
}
