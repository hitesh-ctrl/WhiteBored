import { describe, expect, it } from "vitest";
import { TokenBucket, createBuckets } from "../src/server/rateLimit";

describe("TokenBucket", () => {
  it("allows a burst, then refuses", () => {
    const t = 0;
    const b = new TokenBucket(10, 5, () => t);
    expect([1, 2, 3, 4, 5].map(() => b.take())).toEqual([true, true, true, true, true]);
    expect(b.take()).toBe(false);
  });
  it("refills at the configured rate", () => {
    let t = 0;
    const b = new TokenBucket(10, 5, () => t);
    for (let i = 0; i < 5; i++) b.take();
    t += 100; // 10/s -> one token per 100 ms
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });
  it("never holds more than the burst", () => {
    let t = 0;
    const b = new TokenBucket(10, 3, () => t);
    t += 60_000;
    expect([1, 2, 3, 4].map(() => b.take())).toEqual([true, true, true, false]);
  });
  it("keeps separate buckets per kind", () => {
    const b = createBuckets(() => 0);
    for (let i = 0; i < 10; i++) b.mutate.take();
    expect(b.mutate.take()).toBe(false);
    expect(b.cursor.take()).toBe(true);
  });
});
