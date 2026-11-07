import { describe, expect, it } from "vitest";
import { totalTokens, utcDay } from "./budget.ts";

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
