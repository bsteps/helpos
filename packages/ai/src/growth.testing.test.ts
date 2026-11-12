import { afterEach, describe, expect, it, vi } from "vitest";
import { expectLinearGrowth } from "./growth.testing.ts";

function timedWork(cost: (size: number, now: number, batch: number) => number) {
  let now = 0;
  let reads = 0;
  let batch = 0;
  vi.spyOn(performance, "now").mockImplementation(() => {
    if (reads++ % 2 === 0) batch++;
    return now;
  });
  return (text: string) => {
    now += cost(text.length, now, batch);
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

  it.each([81, 90, 130])("accepts linear work that speeds up at %s ms", (speedupAt) => {
    expectLinearGrowth(
      input,
      timedWork((size, now) => (size / 2_000) * (now < speedupAt ? 1 : 0.1)),
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

  it.each([
    { power: 1, pausedSize: 2_000 },
    { power: 1, pausedSize: 16_000 },
    { power: 2, pausedSize: 2_000 },
    { power: 2, pausedSize: 16_000 },
  ])(
    "handles intermittent slowdowns at size $pausedSize for growth power $power",
    ({ power, pausedSize }) => {
      const run = timedWork(
        (size, _now, batch) =>
          (size / 2_000) ** power * (size === pausedSize && batch % 3 !== 0 ? 4 : 1),
      );
      if (power === 1) expectLinearGrowth(input, run, check);
      else expect(() => expectLinearGrowth(input, run, check)).toThrow("to be less than 24");
    },
  );

  it("rejects quadratic work after a speedup", () => {
    expect(() =>
      expectLinearGrowth(
        input,
        timedWork((size, now) => (size / 2_000) ** 2 * (now < 529 ? 1 : 0.1)),
        check,
      ),
    ).toThrow("to be less than 24");
  });

  it.each([0, 0.000_001])("fails with bounded work when each call takes %s ms", (cost) => {
    let calls = 0;
    const run = timedWork(() => {
      if (++calls > 100_000) throw new Error("measurement work exceeded its bound");
      return cost;
    });
    expect(() => expectLinearGrowth(input, run, check)).toThrow(
      /"count":1024.*to be greater than or equal to 2/,
    );
    expect(calls).toBeLessThan(100_000);
  });

  it("checks measured output", () => {
    expect(() => expectLinearGrowth(input, () => -1, check)).toThrow("to be 2000");
  });

  it("rejects an unmeasurable large input even when the small input is measurable", () => {
    expect(() =>
      expectLinearGrowth(
        input,
        timedWork((size) => (size === 2_000 ? 1 : 0)),
        check,
      ),
    ).toThrow(/"count":1024.*to be greater than or equal to 2/);
  });
});
