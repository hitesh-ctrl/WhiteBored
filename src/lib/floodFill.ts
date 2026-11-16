export type FillResult = { ok: true; points: [number, number][] } | { ok: false; reason: "wall" | "leak" | "tiny" };

const MAX_POINTS = 1500;

/** Grow every set pixel by `r` in each direction (a square), in two passes. Returns a new mask. */
export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return Uint8Array.from(mask);
  const across = new Uint8Array(w * h);
  const prefix = new Int32Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) prefix[x + 1] = prefix[x] + mask[y * w + x];
    for (let x = 0; x < w; x++) across[y * w + x] = prefix[Math.min(w, x + r + 1)] - prefix[Math.max(0, x - r)] > 0 ? 1 : 0;
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) prefix[y + 1] = prefix[y] + across[y * w + x];
    for (let y = 0; y < h; y++) out[y * w + x] = prefix[Math.min(h, y + r + 1)] - prefix[Math.max(0, y - r)] > 0 ? 1 : 0;
  }
  return out;
}

/** Outer outline of the region, as the corner points of its pixels (walked clockwise). */
function outline(region: Uint8Array, w: number, h: number): [number, number][] {
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && region[y * w + x] === 1;
  let first = 0;
  while (first < region.length && region[first] === 0) first++;
  const sx = first % w, sy = Math.floor(first / w);
  const step = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // east, south, west, north
  const corners: [number, number][] = [[sx, sy]];
  let x = sx, y = sy, d = 0, started = false, guard = 4 * w * h + 8;
  // the region is on the right: turn left when the pixel ahead on the left is set, go straight when only the right one is, else turn right
  while (guard-- > 0) {
    if (started && x === sx && y === sy) break;
    started = true;
    let left: boolean, right: boolean;
    if (d === 0) { left = at(x, y - 1); right = at(x, y); }
    else if (d === 1) { left = at(x, y); right = at(x - 1, y); }
    else if (d === 2) { left = at(x - 1, y); right = at(x - 1, y - 1); }
    else { left = at(x - 1, y - 1); right = at(x, y - 1); }
    const next = left ? (d + 3) % 4 : right ? d : (d + 1) % 4;
    if (next !== d) corners.push([x, y]);
    d = next;
    x += step[d][0];
    y += step[d][1];
  }
  return corners;
}

/** Ramer-Douglas-Peucker on a closed ring, written without recursion. */
function simplify(ring: [number, number][], epsilon: number): [number, number][] {
  if (ring.length < 4) return ring;
  const pts = [...ring, ring[0]];
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1, farDist = epsilon;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    for (let i = a + 1; i < b; i++) {
      const dist = Math.abs((by - ay) * pts[i][0] - (bx - ax) * pts[i][1] + bx * ay - by * ax) / len;
      if (dist > farDist) { far = i; farDist = dist; }
    }
    if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  const out = pts.slice(0, -1).filter((_, i) => keep[i]);
  return out.length >= 3 ? out : ring;
}

/**
 * Find the area around a click that is closed in by walls, as an outline to colour.
 *  - `close`: gaps in the walls up to about twice this many pixels count as closed.
 *  - `grow`: the colour is spread this many pixels under the walls, so no blank edge shows beside a line.
 * A click on a thin wall is moved to the nearest free spot; if the area is not closed (it reaches
 * the edge of the picture) the result says "leak".
 */
export function fillPolygonFromWalls(walls: Uint8Array, w: number, h: number, x: number, y: number, opts: { close?: number; grow?: number } = {}): FillResult {
  const close = opts.close ?? 3, grow = opts.grow ?? close;
  const blocked = dilate(walls, w, h, close);
  const sx = Math.floor(x), sy = Math.floor(y);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return { ok: false, reason: "wall" };

  // places to start from: the click itself if it is free, otherwise the nearest free pixels (closest first)
  const reach = close + 3;
  const candidates: [number, number, number][] = [];
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const cx = sx + dx, cy = sy + dy;
      if (cx >= 0 && cy >= 0 && cx < w && cy < h && !blocked[cy * w + cx]) candidates.push([dx * dx + dy * dy, cx, cy]);
    }
  }
  candidates.sort((a, b) => a[0] - b[0]);
  if (candidates.length === 0) return { ok: false, reason: "wall" };

  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let outcome: "leak" | "tiny" = "leak";
  let tried = 0;
  for (const [, cx, cy] of candidates) {
    if (seen[cy * w + cx]) continue;
    if (++tried > 8) break;
    const region = new Uint8Array(w * h);
    let top = 0, count = 0, leaks = false;
    stack[top++] = cy * w + cx;
    seen[cy * w + cx] = 1;
    while (top > 0) {
      const i = stack[--top];
      region[i] = 1;
      count++;
      const px = i % w, py = (i - px) / w;
      if (px === 0 || py === 0 || px === w - 1 || py === h - 1) leaks = true;
      const neighbours = [px > 0 ? i - 1 : -1, px < w - 1 ? i + 1 : -1, py > 0 ? i - w : -1, py < h - 1 ? i + w : -1];
      for (const n of neighbours) if (n >= 0 && !seen[n] && !blocked[n]) { seen[n] = 1; stack[top++] = n; }
    }
    if (leaks) { outcome = "leak"; continue; }
    if (count < 4) { outcome = "tiny"; continue; }
    let ring = outline(dilate(region, w, h, grow), w, h);
    for (let eps = 1; ; eps *= 2) {
      const simple = simplify(ring, eps);
      if (simple.length <= MAX_POINTS || eps > 64) { ring = simple.slice(0, MAX_POINTS); break; }
    }
    return { ok: true, points: ring };
  }
  return { ok: false, reason: outcome };
}
