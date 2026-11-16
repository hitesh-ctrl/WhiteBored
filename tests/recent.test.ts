import { describe, expect, it } from "vitest";
import { parseRecent, upsertRecent, type Recent } from "../src/lib/recent";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const e = (n: number, kind: "edit" | "view" = "edit"): Recent => ({ id: id(n), name: `Board ${n}`, kind, at: n });

describe("upsertRecent", () => {
  it("puts the newest entry first", () => {
    expect(upsertRecent([e(1), e(2)], e(3)).map((x) => x.id)).toEqual([id(3), id(1), id(2)]);
  });
  it("moves an existing board to the front instead of duplicating it, keeping the new name", () => {
    const out = upsertRecent([e(1), e(2)], { ...e(2), name: "Renamed", at: 9 });
    expect(out.map((x) => x.id)).toEqual([id(2), id(1)]);
    expect(out[0].name).toBe("Renamed");
  });
  it("treats the edit and view link of one board as separate entries", () => {
    expect(upsertRecent([e(1, "edit")], e(1, "view"))).toHaveLength(2);
  });
  it("keeps at most 12 entries, dropping the oldest", () => {
    let list: Recent[] = [];
    for (let i = 1; i <= 15; i++) list = upsertRecent(list, e(i));
    expect(list).toHaveLength(12);
    expect(list[0].id).toBe(id(15));
    expect(list.at(-1)?.id).toBe(id(4));
  });
});

describe("parseRecent", () => {
  it("returns an empty list for missing, broken or non-array data", () => {
    for (const bad of [null, "", "not json", "{}", "42", '"x"']) expect(parseRecent(bad)).toEqual([]);
  });
  it("round-trips valid entries", () => {
    expect(parseRecent(JSON.stringify([e(1), e(2, "view")]))).toEqual([e(1), e(2, "view")]);
  });
  it("drops entries with a bad id, kind, name or time and keeps the good ones", () => {
    const raw = JSON.stringify([
      e(1), { ...e(2), id: "../../etc" }, { ...e(3), kind: "admin" }, { ...e(4), name: 5 }, { ...e(5), at: "x" }, { ...e(6), name: "x".repeat(31) },
    ]);
    expect(parseRecent(raw).map((x) => x.id)).toEqual([id(1)]);
  });
  it("keeps a name with markup unchanged, it is rendered as text", () => {
    expect(parseRecent(JSON.stringify([{ ...e(1), name: "<img src=x onerror=alert(1)>" }]))[0].name).toBe("<img src=x onerror=alert(1)>");
  });
  it("never returns more than 12 entries", () => {
    expect(parseRecent(JSON.stringify(Array.from({ length: 40 }, (_, i) => e(i + 1))))).toHaveLength(12);
  });
});
