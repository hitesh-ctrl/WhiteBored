export type Point = [number, number];
const notImplemented = (): never => {
  throw new Error("not implemented");
};
export function toCanvasPoint(..._a: unknown[]): Point { return notImplemented(); }
export function shouldAddPoint(..._a: unknown[]): boolean { return notImplemented(); }
export function nextBatch(..._a: unknown[]): { batch: Point[]; sent: number } | null { return notImplemented(); }
export function ownStrokeIds(..._a: unknown[]): string[] { return notImplemented(); }
