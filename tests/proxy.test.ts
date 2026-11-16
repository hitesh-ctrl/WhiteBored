import { describe, expect, it } from "vitest";
import { clientAddress, trustHops } from "../src/lib/proxy";

describe("trustHops", () => {
  it("reads true as one proxy and numbers from 1 to 10 as that many", () => {
    expect([true, "true", 1, "1", "2", 10, "10"].map(trustHops)).toEqual([1, 1, 1, 1, 2, 10, 10]);
  });
  it("treats everything else as no trusted proxy", () => {
    expect([undefined, false, "false", "0", 0, "-1", "abc", "11", 11, "1.5", "", " 1"].map(trustHops)).toEqual(Array(12).fill(0));
  });
});

describe("clientAddress", () => {
  it("ignores the header when no proxy is trusted", () => {
    expect(clientAddress("6.6.6.6", 0, "10.0.0.1")).toBe("10.0.0.1");
  });
  it("takes the entry added by the trusted proxy: the last one for one hop", () => {
    expect(clientAddress("1.1.1.1", 1, "10.0.0.1")).toBe("1.1.1.1");
    expect(clientAddress("6.6.6.6, 2.2.2.2", 1, "10.0.0.1")).toBe("2.2.2.2");
    expect(clientAddress("6.6.6.6,   2.2.2.2  ", 1, "10.0.0.1")).toBe("2.2.2.2");
  });
  it("counts hops from the right, so values the client prepends never matter", () => {
    expect(clientAddress("evil, 3.3.3.3, 10.1.1.1", 2, "10.0.0.1")).toBe("3.3.3.3");
    expect(clientAddress("a, b, 3.3.3.3, 10.1.1.1", 2, "10.0.0.1")).toBe("3.3.3.3");
  });
  it("falls back when the header is missing, empty, has too few entries or is not an address", () => {
    for (const h of [undefined, "", "   ", "not an ip", "1.1.1.1,"]) expect(clientAddress(h, 1, "10.0.0.1")).toBe(h === "1.1.1.1," ? "10.0.0.1" : "10.0.0.1");
    expect(clientAddress("1.1.1.1", 2, "10.0.0.1")).toBe("10.0.0.1");
  });
  it("groups IPv6 addresses by /64 so one network cannot use many addresses", () => {
    const a = clientAddress("2001:db8:1:2:3:4:5:6", 1, "x");
    const b = clientAddress("2001:db8:1:2:ffff:eeee:dddd:cccc", 1, "x");
    expect(a).toBe(b);
    expect(a).toBe("2001:db8:1:2::/64");
    expect(clientAddress("2001:db8:1:3::1", 1, "x")).not.toBe(a);
  });
  it("expands :: before grouping", () => {
    expect(clientAddress("2001:db8::1", 1, "x")).toBe("2001:db8:0:0::/64");
  });
  it("unwraps IPv4-mapped IPv6 addresses", () => {
    expect(clientAddress("::ffff:1.2.3.4", 1, "x")).toBe("1.2.3.4");
  });
  it("groups the socket address the same way when it is IPv6", () => {
    expect(clientAddress(undefined, 0, "2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(clientAddress(undefined, 0, "::ffff:10.0.0.9")).toBe("10.0.0.9");
  });
});
