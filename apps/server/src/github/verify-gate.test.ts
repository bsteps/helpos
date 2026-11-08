import { afterEach, describe, expect, it, vi } from "vitest";
import { createGate } from "./verify-gate.ts";

const limits = { concurrent: 1, waiting: 2, perWorkspace: 2, waitMs: 1_000 };

describe("the webhook verification gate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets one in at a time and the next waits its turn instead of being refused", async () => {
    const gate = createGate(limits);
    const first = await gate("a");
    expect(first).toBeTypeOf("function");
    let second: (() => void) | null | undefined;
    const waiting = gate("b").then((r) => {
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
    await gate("a");
    const inLine = [gate("b"), gate("c")];
    expect(await gate("d")).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(await Promise.all(inLine)).toEqual([null, null]);
  });

  it("gives one workspace only its share, so its flood can't crowd out another", async () => {
    const gate = createGate({ ...limits, waiting: 10 });
    const held = await gate("flooded");
    const floodedNext = gate("flooded");
    // Its share is used up; another workspace still gets in line, and in first come, first
    // served order gets its turn.
    expect(await gate("flooded")).toBeNull();
    const other = gate("other");
    held?.();
    (await floodedNext)?.();
    expect(await other).toBeTypeOf("function");
  });

  it("frees the slot once, however often release is called", async () => {
    const gate = createGate({ ...limits, waiting: 0 });
    const release = await gate("a");
    release?.();
    release?.();
    const a = await gate("a");
    expect(a).toBeTypeOf("function");
    // Still one at a time: the double release didn't make room for two.
    expect(await gate("b")).toBeNull();
  });
});
