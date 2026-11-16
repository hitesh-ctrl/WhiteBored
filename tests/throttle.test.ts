import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throttle } from "../src/lib/throttle";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("throttle", () => {
  it("calls immediately the first time", () => {
    const fn = vi.fn();
    throttle(fn, 33)(1);
    expect(fn).toHaveBeenCalledWith(1);
  });
  it("collapses calls inside the window to one trailing call with the latest value", () => {
    const fn = vi.fn();
    const t = throttle(fn, 33);
    t(1); t(2); t(3);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(33);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(3);
  });
  it("lets a call through again after the window", () => {
    const fn = vi.fn();
    const t = throttle(fn, 33);
    t(1);
    vi.advanceTimersByTime(40);
    t(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it("does not fire a trailing call when nothing was dropped", () => {
    const fn = vi.fn();
    throttle(fn, 33)(1);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("cancel drops the pending trailing call", () => {
    const fn = vi.fn();
    const t = throttle(fn, 33);
    t(1); t(2);
    t.cancel();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
