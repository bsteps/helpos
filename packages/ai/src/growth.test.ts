import { afterEach, expect, it, vi } from "vitest";
import { expectLinearGrowth } from "./growth.testing.ts";

afterEach(() => vi.restoreAllMocks());

function measuredGrowth(cost: (length: number, calls: number) => number): () => void {
  let elapsed = 0;
  let calls = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  return () =>
    expectLinearGrowth(
      (size) => "x".repeat(size),
      (text) => {
        calls += 1;
        elapsed += cost(text.length, calls);
        return text.length;
      },
      (result, text) => expect(result).toBe(text.length),
    );
}

it("recalibrates when linear work becomes faster during sampling", () => {
  measuredGrowth((length, calls) => length * (calls > 30 ? 0.0001 : 0.0005))();
});

it("still rejects quadratic growth", () => {
  expect(measuredGrowth((length) => (length / 2_000) ** 2)).toThrow(/to be less than 24/);
});

it("rejects samples that remain below the measurable floor", () => {
  expect(measuredGrowth(() => 0)).toThrow(/to be greater than 1/);
});
