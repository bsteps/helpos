import { describe, expect, it } from "vitest";
import { effectiveBudget, nextUtcDay, utcDay } from "./budget.ts";

describe("utcDay", () => {
  it("uses UTC, so the budget resets at UTC midnight whatever the server's time zone", () => {
    expect(utcDay(new Date("2026-11-07T23:59:59.999Z"))).toBe("2026-11-07");
    expect(utcDay(new Date("2026-11-08T00:00:00.000Z"))).toBe("2026-11-08");
    expect(utcDay(new Date("2026-11-08T05:00:00+05:30"))).toBe("2026-11-07");
  });

  it("the budget resets at the next midnight UTC", () => {
    expect(nextUtcDay(new Date("2026-03-31T23:59:59Z")).toISOString()).toBe(
      "2026-04-01T00:00:00.000Z",
    );
    expect(nextUtcDay(new Date("2026-12-31T00:00:00Z")).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });
});

describe("effectiveBudget", () => {
  it("is the workspace's own budget, never above the server-wide ceiling", () => {
    expect(effectiveBudget(100, 200)).toBe(100);
    expect(effectiveBudget(500, 200)).toBe(200);
    expect(effectiveBudget(0, 200)).toBe(0);
    // No value of its own: the ceiling.
    expect(effectiveBudget(null, 200)).toBe(200);
  });
});
