export function throttle<A extends unknown[]>(_fn: (...a: A) => void, _ms: number): ((...a: A) => void) & { cancel(): void } {
  throw new Error("not implemented");
}
