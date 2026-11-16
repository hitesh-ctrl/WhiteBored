const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Headers for sending an uploaded picture to a browser. The type is the stored one (checked against an
 * allow-list, so a bad value in the database can never be sent as something else), the browser may not
 * guess another type, the file is locked down if someone opens it directly, and it is cached for good
 * because a picture's bytes never change under its id. Returns null for a type that must not be served.
 */
export function imageHeaders(mime: string | null | undefined): Record<string, string> | null {
  if (typeof mime !== "string" || !ALLOWED.has(mime)) return null;
  return {
    "content-type": mime,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "public, max-age=31536000, immutable",
    "cross-origin-resource-policy": "same-origin",
  };
}
