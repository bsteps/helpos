import { schema } from "@helpos/db";
import { describe, expect, it } from "vitest";
import { edges, reachable } from "../testing/transitions.ts";
import { draftTransitions } from "./lifecycle.ts";

describe("draft lifecycle", () => {
  it("allows exactly these status changes", () => {
    // A new status, or a new way into one, is a product decision: it changes this list.
    expect(edges(draftTransitions)).toEqual(
      [
        "pending → pending (edit)",
        "pending → approved (approve)",
        "pending → discarded (discard)",
        "send_failed → discarded (discard)",
        "pending → discarded (discardStale)",
        "approved → send_uncertain (markSending)",
        "send_uncertain → send_uncertain (markSending)",
        "send_uncertain → sent (markSent)",
        "send_uncertain → sent (confirmSent)",
        "send_uncertain → send_uncertain (resend)",
        "send_uncertain → approved (rejectSend)",
        "approved → send_failed (markSendFailed)",
        "send_failed → approved (retry)",
      ].sort(),
    );
  });

  it("reaches every status from a new pending draft", () => {
    expect(reachable(draftTransitions, "pending")).toEqual([...schema.draftStatuses].sort());
  });
});
