/** Token bucket per key (for example per client address), with bounded memory. */
export class KeyedLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();
  private readonly burst: number;
  private readonly perMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number;
  private lastPrune = 0;

  constructor(opts: { burst: number; perMinute: number; now?: () => number; maxKeys?: number }) {
    this.burst = opts.burst;
    this.perMs = opts.perMinute / 60_000;
    this.now = opts.now ?? Date.now;
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  allow(key: string): boolean {
    const t = this.now();
    this.prune(t);
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
      b = { tokens: this.burst, last: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + (t - b.last) * this.perMs);
    b.last = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  size() {
    return this.buckets.size;
  }

  /** A bucket that has been idle long enough to be full again is the same as no bucket. */
  private prune(t: number) {
    if (t - this.lastPrune < 1000) return;
    this.lastPrune = t;
    const fullAfter = this.burst / this.perMs;
    for (const [k, b] of this.buckets) if (t - b.last >= fullAfter) this.buckets.delete(k);
  }
}
