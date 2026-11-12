import { describe, expect, it } from "vitest";
import { expectLinearGrowth } from "./growth.testing.ts";

const input = (size: number) => "x".repeat(size);
const check = (result: number, text: string) => expect(result).toBe(text.length);

function measuredGrowth(cost: (size: number, now: number, batch: number) => number): void {
  let now = 0;
  let reads = 0;
  let batch = 0;
  expectLinearGrowth(
    input,
    (text) => {
      now += cost(text.length, now, batch);
      return text.length;
    },
    check,
    () => {
      if (reads++ % 2 === 0) batch++;
      return now;
    },
  );
}

describe("expectLinearGrowth", () => {
  it("accepts linear work", () => {
    measuredGrowth((size) => size / 2_000);
  });

  it("bounds measurement work when linear samples stay stable", () => {
    let calls = 0;
    measuredGrowth((size) => {
      calls++;
      return (size / 2_000) * 0.003;
    });
    expect(calls).toBeLessThan(30_000);
  });

  it.each([81, 90, 130])("accepts linear work that speeds up at %s ms", (speedupAt) => {
    measuredGrowth((size, now) => (size / 2_000) * (now < speedupAt ? 1 : 0.1));
  });

  it("rejects quadratic work", () => {
    expect(() => measuredGrowth((size) => (size / 2_000) ** 2)).toThrow("to be less than 24");
  });

  it.each([
    { power: 1, pausedSize: 2_000 },
    { power: 1, pausedSize: 16_000 },
    { power: 2, pausedSize: 2_000 },
    { power: 2, pausedSize: 16_000 },
  ])(
    "handles intermittent slowdowns at size $pausedSize for growth power $power",
    ({ power, pausedSize }) => {
      const run = () =>
        measuredGrowth(
          (size, _now, batch) =>
            (size / 2_000) ** power * (size === pausedSize && batch % 3 !== 0 ? 4 : 1),
        );
      if (power === 1) run();
      else expect(run).toThrow("to be less than 24");
    },
  );

  it("rejects quadratic work after a speedup", () => {
    expect(() =>
      measuredGrowth((size, now) => (size / 2_000) ** 2 * (now < 529 ? 1 : 0.1)),
    ).toThrow("to be less than 24");
  });

  it.each([0, 0.000_001])("fails with bounded work when each call takes %s ms", (cost) => {
    let calls = 0;
    expect(() =>
      measuredGrowth(() => {
        if (++calls > 100_000) throw new Error("measurement work exceeded its bound");
        return cost;
      }),
    ).toThrow(/"count":1024.*to be greater than 1/);
    expect(calls).toBeLessThan(100_000);
  });

  it("checks measured output", () => {
    expect(() => expectLinearGrowth(input, () => -1, check)).toThrow("to be 2000");
  });

  it("rejects an unmeasurable large input even when the small input is measurable", () => {
    expect(() => measuredGrowth((size) => (size === 2_000 ? 1 : 0))).toThrow(
      /"count":1024.*to be greater than 1/,
    );
  });
});
