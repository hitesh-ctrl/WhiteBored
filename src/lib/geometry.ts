import type { Point } from "./drawing";
export type Shape = { kind: string; width: number; points: Point[]; text?: string | null };
const ni = (): never => { throw new Error("not implemented"); };
export function strokeHit(..._a: unknown[]): boolean { return ni(); }
export function strokeBounds(..._a: unknown[]): { x: number; y: number; w: number; h: number } { return ni(); }
