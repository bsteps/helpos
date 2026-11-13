import { schema } from "@helpos/db";
import { describe, expect, it } from "vitest";
import { draftTransitions } from "./lifecycle.ts";

/** Every status change the table allows, as "from → to (operation)". */
function edges(): string[] {
  return Object.entries(draftTransitions)
    .flatMap(([op, t]) => t.from.map((from) => `${from} → ${t.to} (${op})`))
    .sort();
}

describe("draft lifecycle", () => {
  it("allows exactly these status changes", () => {
    // A new status, or a new way into one, is a product decision: it changes this list.
    expect(edges()).toEqual(
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
    const reached = new Set<string>(["pending"]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of Object.values(draftTransitions)) {
        if (t.from.some((s) => reached.has(s)) && !reached.has(t.to)) {
          reached.add(t.to);
          grew = true;
        }
      }
    }
    expect([...reached].sort()).toEqual([...schema.draftStatuses].sort());
  });
});
