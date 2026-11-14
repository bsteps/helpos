import { describe, expect, it } from "vitest";
import { edges, reachable } from "../testing/transitions.ts";
import { sourceStatuses, sourceTransitions } from "./source-lifecycle.ts";

const statuses = [...sourceStatuses].sort();

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
});
