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

  const collect = (count: number) => {
    const sample = (order: number) => {
      if (order % 2 === 0) {
        const n = measure(small, count);
        return { n, eightN: measure(large, count) };
      }
      const eightN = measure(large, count);
      return { n: measure(small, count), eightN };
    };
    const pairs = Array.from({ length: 7 }, (_, order) => {
      const first = sample(order);
      return { ...first, samples: [first] };
    });
    // A twofold spread leaves the 8x/64x controls on opposite sides of the 24x growth limit.
    const varies = (durations: number[]) => Math.max(...durations) > 2 * Math.min(...durations);
    // Stable CPU samples need no extra work. Only same-input timing spread requests more samples.
    if (!varies(pairs.map(({ n }) => n)) && !varies(pairs.map(({ eightN }) => eightN))) {
      return pairs;
    }
    return pairs.map((pair, order) => {
      const samples = [...pair.samples, sample(order + 1), sample(order + 2)];
      // Use each input's fastest batch to reduce scheduling noise at equal work counts.
      return {
        n: Math.min(...samples.map(({ n }) => n)),
        eightN: Math.min(...samples.map(({ eightN }) => eightN)),
        samples,
      };
    });
  };
  let pairs = collect(count);
  const discarded: { count: number; pairs: typeof pairs }[] = [];
  while (pairs.some(({ n, eightN }) => n < 2 || eightN < 2) && count < 1_024) {
    discarded.push({ count, pairs });
    count *= 2;
    // Restart all seven pairs so a speed change cannot mix batch sizes or select ratios.
    pairs = collect(count);
  }
  const ratios = pairs.map(({ n, eightN }) => eightN / n).sort((a, b) => a - b);
  const evidence = JSON.stringify({ count, pairs, ratios, discarded });
  expect(Math.min(...pairs.flatMap(({ n, eightN }) => [n, eightN])), evidence).toBeGreaterThan(1);
  // 8x the input costs about 8x when linear and 64x when quadratic. The median of the pairs
  // ignores a pause on a busy machine. A quadratic part too small to dominate at n passes.
  expect(ratios[Math.floor(ratios.length / 2)], evidence).toBeLessThan(24);
}
