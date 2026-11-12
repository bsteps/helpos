import { describe, expect, it } from "vitest";
import { dailyBudgetRefusal, effectiveBudget, mapAiRefusal, nextUtcDay, utcDay } from "./budget.ts";

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

it("maps the budget refusal without changing the caller's outcome", () => {
  const refusal = dailyBudgetRefusal({ paused: true, day: "2026-12-31" });
  expect(refusal).toEqual({ refused: "over_budget", retryAt: new Date("2027-01-01T00:00:00Z") });
  expect(dailyBudgetRefusal({ paused: false, day: "2026-12-31" })).toBeNull();
  if (!refusal) throw new Error("Expected refusal");
  const handlers = {
    busy: (at: Date) => `wait:${at.toISOString()}`,
    over_budget: (at: Date) => `paused:${at.toISOString()}`,
  };
  expect(mapAiRefusal(refusal, handlers)).toBe("paused:2027-01-01T00:00:00.000Z");
  expect(mapAiRefusal({ refused: "busy", retryAt: refusal.retryAt }, handlers)).toBe(
    "wait:2027-01-01T00:00:00.000Z",
  );
});
