import { afterEach, describe, expect, it, vi } from "vitest";
import { createGate, recentIds } from "./verify-gate.ts";

const limits = { concurrent: 1, waiting: 2, perWorkspace: 2, waitMs: 1_000 };

describe("the webhook verification gate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets one in at a time and the next waits its turn instead of being refused", async () => {
    const gate = createGate(limits);
    const first = await gate("a", false);
    expect(first).toBeTypeOf("function");
    let second: (() => void) | null | undefined;
    const waiting = gate("b", false).then((r) => {
      second = r;
    });
    await Promise.resolve();
    expect(second).toBeUndefined();
    first?.();
    await waiting;
    expect(second).toBeTypeOf("function");
  });

  it("turns away what doesn't fit in line, and a wait that runs too long", async () => {
    vi.useFakeTimers();
    const gate = createGate(limits);
    await gate("a", false);
    const inLine = [gate("b", false), gate("c", false)];
    expect(await gate("d", false)).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(await Promise.all(inLine)).toEqual([null, null]);
  });

  it("gives one workspace only its share, so its flood can't crowd out another", async () => {
    const gate = createGate({ ...limits, waiting: 10 });
    const held = await gate("flooded", false);
    const floodedNext = gate("flooded", false);
    // Its share is used up; another workspace still gets in line, and in first come, first
    // served order gets its turn.
    expect(await gate("flooded", false)).toBeNull();
    const other = gate("other", false);
    held?.();
    (await floodedNext)?.();
    expect(await other).toBeTypeOf("function");
  });

  it("lets a known workspace past a flood of made-up ones, which can't fill its line", async () => {
    const gate = createGate({ ...limits, waiting: 3 });
    const held = await gate("forged-0", false);
    // Fresh random workspaces each time, so no share stops them: they fill the line.
    const forged = [1, 2, 3].map((i) => gate(`forged-${i}`, false));
    expect(await gate("forged-4", false)).toBeNull();
    // A workspace that has verified before has its own line, which goes first.
    const order: string[] = [];
    const real = gate("real", true).then((release) => {
      order.push("real");
      release?.();
    });
    for (const [i, f] of forged.entries()) {
      void f.then((release) => {
        order.push(`forged-${i + 1}`);
        release?.();
      });
    }
    held?.();
    await real;
    await Promise.all(forged);
    expect(order[0]).toBe("real");
  });

  it("frees the slot once, however often release is called", async () => {
    const gate = createGate({ ...limits, waiting: 0 });
    const release = await gate("a", false);
    release?.();
    release?.();
    const a = await gate("a", false);
    expect(a).toBeTypeOf("function");
    // Still one at a time: the double release didn't make room for two.
    expect(await gate("b", false)).toBeNull();
  });
});

describe("recentIds", () => {
  it("forgets its oldest past the limit, so a flood of new IDs can't grow it", () => {
    const ids = recentIds(2);
    ids.add("a");
    ids.add("b");
    ids.add("a");
    ids.add("c");
    // "a" was re-added, so "b" was the oldest.
    expect(["a", "b", "c"].map((id) => ids.has(id))).toEqual([true, false, true]);
    ids.delete("a");
    expect(ids.has("a")).toBe(false);
  });
});
