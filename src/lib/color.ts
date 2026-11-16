/** A stable colour per client id, dark enough for white text. */
export function colorFor(id: string): string {
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return `hsl(${(h >>> 0) % 360} 65% 38%)`;
}
