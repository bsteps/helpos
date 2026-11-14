import { schema } from "@helpos/db";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { edges, reachable, walks } from "../testing/transitions.ts";
import { conversationTransitions } from "./lifecycle.ts";

describe("conversation lifecycle", () => {
  it("allows exactly these status changes", () => {
    expect(edges(conversationTransitions)).toEqual(
      [
        "open → closed (close)",
        "open → open (personReplied)",
        "closed → open (personReplied)",
      ].sort(),
    );
  });

  it("reaches every status from a new open conversation", () => {
    expect(reachable(conversationTransitions, "open")).toEqual(
      [...schema.conversationStatuses].sort(),
    );
  });

  it("reopens a closed conversation only when a person writes in", () => {
    fc.assert(
      fc.property(walks(conversationTransitions, "open"), (steps) => {
        for (const { operation, before, after } of steps) {
          expect(schema.conversationStatuses).toContain(after);
          if (before === "closed" && after === "open") expect(operation).toBe("personReplied");
          if (operation === "close") expect(after).toBe("closed");
        }
      }),
    );
  });
});
