import { describe, expect, it } from "vitest";
import { KeyedLimiter } from "../src/lib/keyedLimiter";

describe("KeyedLimiter", () => {
  it("allows the burst per key and then refuses", () => {
    const t = 0;
    const l = new KeyedLimiter({ burst: 5, perMinute: 5, now: () => t });
    expect([1, 2, 3, 4, 5].every(() => l.allow("ip-1"))).toBe(true);
    expect(l.allow("ip-1")).toBe(false);
    expect(l.allow("ip-2")).toBe(true);
  });
  it("refills one token every 12 seconds at 5 per minute", () => {
    let t = 0;
    const l = new KeyedLimiter({ burst: 5, perMinute: 5, now: () => t });
    for (let i = 0; i < 5; i++) l.allow("k");
    t += 11_000;
    expect(l.allow("k")).toBe(false);
    t += 1_500;
    expect(l.allow("k")).toBe(true);
    expect(l.allow("k")).toBe(false);
  });
  it("forgets idle keys so memory does not grow without bound", () => {
    let t = 0;
    const l = new KeyedLimiter({ burst: 5, perMinute: 5, now: () => t });
    for (let i = 0; i < 100; i++) l.allow(`k${i}`);
    expect(l.size()).toBe(100);
    t += 10 * 60_000;
    l.allow("fresh");
    expect(l.size()).toBe(1);
  });
  it("caps the number of tracked keys", () => {
    const l = new KeyedLimiter({ burst: 5, perMinute: 5, now: () => 0, maxKeys: 50 });
    for (let i = 0; i < 500; i++) l.allow(`k${i}`);
    expect(l.size()).toBeLessThanOrEqual(50);
  });
});
