import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { edges, reachable, walks } from "../testing/transitions.ts";
import { sourceStatuses, sourceTransitions } from "./source-lifecycle.ts";

const statuses = [...sourceStatuses].sort();
const workerOperations: string[] = ["wait", "fail", "ingested"];

describe("knowledge source lifecycle", () => {
  it("allows exactly these state changes", () => {
    expect(edges(sourceTransitions)).toEqual(
      [
        ...statuses.map((s) => `${s} → pending (reingest)`),
        "waiting → waiting (reingestWhileOverBudget)",
        ...statuses.map((s) => `${s} → pending (editContent)`),
        "pending → waiting (wait)",
        "waiting → waiting (wait)",
        "pending → failed (fail)",
        "waiting → failed (fail)",
        "pending → ready (ingested)",
        "waiting → ready (ingested)",
      ].sort(),
    );
  });

  it("reaches every status from a new pending source", () => {
    expect(reachable(sourceTransitions, "pending")).toEqual(statuses);
  });

  it("lets the worker change only a source it is ingesting, and only a request restarts one", () => {
    fc.assert(
      fc.property(walks(sourceTransitions, "pending"), (steps) => {
        for (const { operation, before, after } of steps) {
          expect(statuses).toContain(after);
          const finished = before === "ready" || before === "failed";
          if (finished && workerOperations.includes(operation)) expect(after).toBe(before);
          if (after === "ready" && before !== "ready") expect(operation).toBe("ingested");
        }
      }),
    );
  });
});
