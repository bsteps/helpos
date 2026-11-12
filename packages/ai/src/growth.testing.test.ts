import { afterEach, describe, expect, it, vi } from "vitest";
import { expectLinearGrowth } from "./growth.testing.ts";

function timedWork(cost: (size: number, now: number) => number) {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return (text: string) => {
    now += cost(text.length, now);
    return text.length;
  };
}

const input = (size: number) => "x".repeat(size);
const check = (result: number, text: string) => expect(result).toBe(text.length);

afterEach(() => vi.restoreAllMocks());

describe("expectLinearGrowth", () => {
  it("accepts linear work", () => {
    expectLinearGrowth(
      input,
      timedWork((size) => size / 2_000),
      check,
    );
  });

  it("accepts linear work that speeds up after calibration", () => {
    expectLinearGrowth(
      input,
      timedWork((size, now) => (size / 2_000) * (now < 81 ? 1 : 0.1)),
      check,
    );
  });

  it("rejects quadratic work", () => {
    expect(() =>
      expectLinearGrowth(
        input,
        timedWork((size) => (size / 2_000) ** 2),
        check,
      ),
    ).toThrow("to be less than 24");
  });
});
