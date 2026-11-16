const DEV_DEFAULT = "http://localhost:4000";

/**
 * Where the browser finds the socket server. Not set at all: the local development address.
 * Set to an empty string: the page's own address (one server or proxy in front of both parts).
 * Anything else: that address.
 */
export function socketBase(value: string | undefined): string | undefined {
  if (value === undefined) return DEV_DEFAULT;
  const v = value.trim();
  return v === "" ? undefined : v;
}
