import { schema } from "@helpos/db";
import { describe, expect, it } from "vitest";
import { edges, reachable } from "../testing/transitions.ts";
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
});
