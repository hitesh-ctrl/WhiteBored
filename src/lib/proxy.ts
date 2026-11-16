import { isIP } from "node:net";

/** Normalised form used to count a client: IPv4 as is, IPv6 reduced to its /64 network. */
function normalize(address: string): string | null {
  let a = address.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) a = mapped[1];
  const kind = isIP(a);
  if (kind === 0) return null;
  if (kind === 4) return a;
  const [head, tail] = a.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/**
 * The address to count a client by. `hops` is the number of trusted proxies in front of us; each
 * one appends the address it saw, so the entry we can believe is `hops` places from the END of
 * X-Forwarded-For. Anything the client put at the front is ignored. With no trusted proxy the
 * header is ignored altogether and the socket's own address is used.
 */
export function clientAddress(header: string | undefined, hops: number, fallback: string): string {
  const own = normalize(fallback) ?? fallback;
  if (hops <= 0 || !header) return own;
  const entries = header.split(",").map((s) => s.trim());
  const entry = entries[entries.length - hops];
  return (entry ? normalize(entry) : null) ?? own;
}

/** TRUST_PROXY: "true" means one proxy, a number from 1 to 10 means that many, anything else none. */
export function trustHops(value: string | number | boolean | undefined): number {
  if (value === true || value === "true") return 1;
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : 0;
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 0;
}
