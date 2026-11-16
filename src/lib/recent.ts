import { MAX_NAME_LENGTH } from "../shared/limits";

/** A board this browser has opened, kept in localStorage. Only ids and names, never keys. */
export type Recent = { id: string; name: string; kind: "edit" | "view"; at: number };
export const RECENT_KEY = "whiteboard:recent";
const MAX = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Newest first, one entry per board and link kind, at most 12. */
export function upsertRecent(list: Recent[], entry: Recent): Recent[] {
  return [entry, ...list.filter((r) => !(r.id === entry.id && r.kind === entry.kind))].slice(0, MAX);
}

const valid = (r: unknown): r is Recent => {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.id === "string" && UUID.test(o.id) &&
    (o.kind === "edit" || o.kind === "view") &&
    typeof o.name === "string" && o.name.length >= 1 && o.name.length <= MAX_NAME_LENGTH &&
    typeof o.at === "number" && Number.isFinite(o.at)
  );
};

/** Storage can hold anything, so check every entry before it is used to build a link. */
export function parseRecent(raw: string | null): Recent[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    return Array.isArray(data) ? data.filter(valid).slice(0, MAX) : [];
  } catch {
    return [];
  }
}
