export type View = { zoom: number; panX: number; panY: number };
export const DEFAULT_VIEW: View = { zoom: 1, panX: 0, panY: 0 };
const ni = (): never => { throw new Error("not implemented"); };
export function screenToCanvas(..._a: unknown[]): [number, number] { return ni(); }
export function clampView(..._a: unknown[]): View { return ni(); }
export function zoomAt(..._a: unknown[]): View { return ni(); }
export function panBy(..._a: unknown[]): View { return ni(); }
