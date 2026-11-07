import { describe, expect, it } from "vitest";
import { effectiveBudget, totalTokens, utcDay } from "./budget.ts";

describe("utcDay", () => {
  it("uses UTC, so the budget resets at UTC midnight whatever the server's time zone", () => {
    expect(utcDay(new Date("2026-11-07T23:59:59.999Z"))).toBe("2026-11-07");
    expect(utcDay(new Date("2026-11-08T00:00:00.000Z"))).toBe("2026-11-08");
    expect(utcDay(new Date("2026-11-08T05:00:00+05:30"))).toBe("2026-11-07");
  });

  it("totalTokens adds input and output", () => {
    expect(totalTokens({ inputTokens: 3, outputTokens: 4 })).toBe(7);
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
