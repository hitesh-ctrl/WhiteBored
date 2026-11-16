import { describe, expect, it } from "vitest";
import { UndoRedo } from "../src/lib/history";

const s = (id: string) => ({ id, color: "#000000" });

describe("UndoRedo", () => {
  it("top is the newest own stroke", () => {
    const h = new UndoRedo<{ id: string }>();
    h.recordDraw("a"); h.recordDraw("b");
    expect(h.top()).toBe("b");
    expect(h.size()).toBe(2);
  });
  it("remove takes out any stroke and keeps the order of the rest", () => {
    const h = new UndoRedo<{ id: string }>();
    ["a", "b", "c"].forEach((x) => h.recordDraw(x));
    h.remove("b");
    expect(h.ids()).toEqual(["a", "c"]);
    h.remove("zzz");
    expect(h.ids()).toEqual(["a", "c"]);
  });
  it("redo gives back removed strokes newest removal first", () => {
    const h = new UndoRedo<{ id: string }>();
    h.pushRedo(s("a")); h.pushRedo(s("b"));
    expect(h.popRedo()?.id).toBe("b");
    expect(h.popRedo()?.id).toBe("a");
    expect(h.popRedo()).toBeUndefined();
  });
  it("drawing something new forgets the redo list", () => {
    const h = new UndoRedo<{ id: string }>();
    h.pushRedo(s("a"));
    h.recordDraw("n");
    expect(h.canRedo()).toBe(false);
  });
  it("restore puts a redone stroke back on top without forgetting the rest of the redo list", () => {
    const h = new UndoRedo<{ id: string }>();
    h.pushRedo(s("a")); h.pushRedo(s("b"));
    const b = h.popRedo()!;
    h.restore(b.id);
    expect(h.top()).toBe("b");
    expect(h.canRedo()).toBe(true);
  });
  it("keeps at most 100 redo entries, dropping the oldest", () => {
    const h = new UndoRedo<{ id: string }>();
    for (let i = 0; i < 120; i++) h.pushRedo(s(`s${i}`));
    expect(h.redoSize()).toBe(100);
    let last; for (let i = 0; i < 100; i++) last = h.popRedo();
    expect(last?.id).toBe("s20");
  });
  it("reset replaces the own strokes and clears redo", () => {
    const h = new UndoRedo<{ id: string }>();
    h.recordDraw("a"); h.pushRedo(s("x"));
    h.reset(["p", "q"]);
    expect(h.ids()).toEqual(["p", "q"]);
    expect(h.canRedo()).toBe(false);
  });
});
