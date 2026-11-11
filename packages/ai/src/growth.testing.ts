import { expect } from "vitest";

export function expectLinearGrowth<T>(
  input: (size: number) => string,
  run: (text: string) => T,
  check: (result: T, text: string) => void,
): void {
  const small = input(2_000);
  const large = input(16_000);
  const measure = (text: string, count: number) => {
    const started = performance.now();
    let result = run(text);
    for (let i = 1; i < count; i++) result = run(text);
    const elapsed = performance.now() - started;
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

  const pairs = Array.from({ length: 7 }, (_, i) => {
    if (i % 2 === 0) {
      const n = measure(small, count);
      return { n, eightN: measure(large, count) };
    }
    const eightN = measure(large, count);
    return { n: measure(small, count), eightN };
  });
  const ratios = pairs.map(({ n, eightN }) => eightN / n).sort((a, b) => a - b);
  const evidence = JSON.stringify({ count, pairs, ratios });
  expect(Math.min(...pairs.map(({ n }) => n)), evidence).toBeGreaterThan(1);
  expect(ratios[3], evidence).toBeLessThan(24);
}
