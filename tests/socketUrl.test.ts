import { describe, expect, it } from "vitest";
import { socketBase } from "../src/lib/socketUrl";

describe("socketBase", () => {
  it("uses the development address when nothing is set", () => {
    expect(socketBase(undefined)).toBe("http://localhost:4000");
  });
  it("means the page's own address when set to an empty or blank string", () => {
    expect(socketBase("")).toBeUndefined();
    expect(socketBase("   ")).toBeUndefined();
  });
  it("uses a given address as it is, minus surrounding spaces", () => {
    expect(socketBase("https://socket.example.com")).toBe("https://socket.example.com");
    expect(socketBase("  http://192.168.1.2:4400 ")).toBe("http://192.168.1.2:4400");
  });
});
