/**
 * A stable colour per client id, dark enough for white text. 360 hues times three lightness levels,
 * so two people rarely end up with the same one.
 */
export function colorFor(id: string): string {
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const n = h >>> 0;
  return `hsl(${n % 360} 65% ${30 + 4 * (Math.floor(n / 360) % 3)}%)`;
}
