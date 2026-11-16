/** Leading-edge throttle that also delivers the latest dropped call at the end of the window. */
export function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | undefined;

  const run = (args: A) => {
    last = Date.now();
    fn(...args);
  };

  const throttled = (...args: A) => {
    const wait = last + ms - Date.now();
    if (wait <= 0) {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
      run(args);
      return;
    }
    pending = args;
    timer ??= setTimeout(() => {
      timer = undefined;
      const p = pending;
      pending = undefined;
      if (p) run(p);
    }, wait);
  };
  throttled.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  return throttled;
}
