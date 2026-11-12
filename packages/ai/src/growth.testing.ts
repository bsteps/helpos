import { expect } from "vitest";

function growthClockMilliseconds(): number {
  // Windows process CPU accounting is too coarse for these millisecond samples.
  if (process.platform === "win32") return performance.now();
  const { user, system } = process.cpuUsage();
  return (user + system) / 1_000;
}

export function expectLinearGrowth<T>(
  input: (size: number) => string,
  run: (text: string) => T,
  check: (result: T, text: string) => void,
  nowMilliseconds: () => number = growthClockMilliseconds,
): void {
  const small = input(2_000);
  const large = input(16_000);
  const measure = (text: string, count: number) => {
    const started = nowMilliseconds();
    let result = run(text);
    for (let i = 1; i < count; i++) result = run(text);
    const elapsed = nowMilliseconds() - started;
    check(result, text);
    return elapsed;
  };

  for (let i = 0; i < 8; i++) {
    measure(small, 1);
    measure(large, 1);
  }
  let count = 1;
  while (count < 1_024) {
    const calibration = Array.from({ length: 3 }, () => measure(small, count));
    if (Math.min(...calibration) >= 2) break;
    count *= 2;
  }

  const sample = () =>
    Array.from({ length: 7 }, (_, i) => {
      if (i % 2 === 0) {
        const n = measure(small, count);
        return { n, eightN: measure(large, count) };
      }
      const eightN = measure(large, count);
      return { n: measure(small, count), eightN };
    });
  let pairs = sample();
  while (count < 1_024 && pairs.some(({ n }) => n <= 1)) {
    count *= 2;
    pairs = sample();
  }
  const ratios = pairs.map(({ n, eightN }) => eightN / n).sort((a, b) => a - b);
  const evidence = JSON.stringify({ count, pairs, ratios });
  expect(Math.min(...pairs.map(({ n }) => n)), evidence).toBeGreaterThan(1);
  // 8x the input costs about 8x when linear and 64x when quadratic. The median of the pairs
  // ignores a pause on a busy machine. A quadratic part too small to dominate at n passes.
  expect(ratios[Math.floor(ratios.length / 2)], evidence).toBeLessThan(24);
}
