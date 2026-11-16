import { describe, expect, it } from "vitest";
import { idSchema, joinSchema } from "../src/shared/protocol";
import { newId, newSecret } from "../src/lib/ids";

describe("newId", () => {
  it("makes ids the protocol accepts, and different every time", () => {
    const ids = Array.from({ length: 200 }, newId);
    expect(ids.every((i) => idSchema.safeParse(i).success)).toBe(true);
    expect(new Set(ids).size).toBe(200);
  });
});

describe("newSecret", () => {
  it("makes long, URL-safe, unique keys that the join message accepts", () => {
    const keys = Array.from({ length: 200 }, newSecret);
    expect(keys.every((k) => /^[A-Za-z0-9_-]{32}$/.test(k))).toBe(true);
    expect(new Set(keys).size).toBe(200);
    expect(joinSchema.safeParse({ boardId: newId(), clientId: newId(), name: "x", clientKey: keys[0] }).success).toBe(true);
  });
});
