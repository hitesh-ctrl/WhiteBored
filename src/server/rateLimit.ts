/** Token bucket: `burst` tokens at most, refilled at `ratePerSec`. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }
  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.ratePerSec);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export type LimitKind = "join" | "progress" | "commit" | "undo" | "mutate" | "cursor";

/** Per-socket limits, see docs/DESIGN.md section 3. `mutate` covers undo and clear. */
export const RATE_LIMITS: Record<LimitKind, { ratePerSec: number; burst: number }> = {
  join: { ratePerSec: 2, burst: 5 },
  progress: { ratePerSec: 40, burst: 80 },
  commit: { ratePerSec: 5, burst: 20 },
  // the eraser removes many strokes in one sweep, so undo gets more room than clear and rename
  undo: { ratePerSec: 30, burst: 60 },
  mutate: { ratePerSec: 5, burst: 10 },
  cursor: { ratePerSec: 60, burst: 30 },
};

export function createBuckets(now?: () => number): Record<LimitKind, TokenBucket> {
  const mk = (k: LimitKind) => new TokenBucket(RATE_LIMITS[k].ratePerSec, RATE_LIMITS[k].burst, now);
  return { join: mk("join"), progress: mk("progress"), commit: mk("commit"), undo: mk("undo"), mutate: mk("mutate"), cursor: mk("cursor") };
}
