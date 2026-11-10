import { describe, expect, it } from "vitest";
import type { Draft, TicketDetail } from "@/api/client.ts";
import { draftView, liveFixNotice, newDraftError, waitingOn } from "./draft-view.ts";

const ticket: TicketDetail = {
  id: "t1",
  subject: "Wrong size",
  status: "open",
  customer: { email: "jane@customer.test", name: "Jane" },
  createdAt: "2026-11-09T09:00:00.000Z",
  lastMessageAt: "2026-11-09T09:00:00.000Z",
  automated: false,
  aiPausedReason: null,
  replyNotSent: false,
  messages: [],
  githubIssue: null,
};

const sentAt = "2026-11-09T10:00:00.000Z";

function draft(id: string, status: Draft["status"], kind: Draft["kind"] = "reply"): Draft {
  const approved = status === "sent" || status === "approved" || status === "send_failed";
  return {
    id,
    ticketId: ticket.id,
    messageId: "m1",
    kind,
    status,
    body: "Thanks for writing in.",
    createdAt: "2026-11-09T09:30:00.000Z",
    updatedAt: "2026-11-09T09:30:00.000Z",
    approvedAt: approved ? sentAt : null,
    sentAt: status === "sent" ? sentAt : null,
    sources: [],
    internalKnowledge: false,
    quotesInternalNote: false,
  };
}

function inbound(id: string): TicketDetail["messages"][number] {
  return {
    id,
    direction: "inbound",
    from: { address: "jane@customer.test", name: "Jane" },
    to: ["support@acme.test"],
    subject: "Late parcel",
    text: "Where is it?",
    html: null,
    createdAt: "2026-11-09T09:00:00.000Z",
  };
}

function failedThenDiscarded(id: string): Draft {
  return { ...draft(id, "discarded"), approvedAt: sentAt };
}

describe("draftView", () => {
  it("offers the choice, not a spinner, after a pending draft is discarded", () => {
    const drafts = [draft("d1", "discarded")];
    expect(draftView(ticket, drafts, undefined, false)).toEqual({
      kind: "choose",
      after: "discarded",
    });
    expect(waitingOn(ticket, undefined)(drafts)).toBe(false);
  });

  it("says a reply that failed to send was discarded", () => {
    expect(draftView(ticket, [failedThenDiscarded("d1")], undefined, false)).toEqual({
      kind: "choose",
      after: "send_failed",
    });
  });

  it("doesn't bring back an older sent reply when the newest one was discarded", () => {
    const drafts = [draft("d1", "sent"), draft("d2", "discarded")];
    expect(draftView(ticket, drafts, undefined, false).kind).toBe("choose");
  });

  it("waits for an asked-for draft, then shows it when it arrives", () => {
    const ask = { replacing: "d1" };
    const waiting = [draft("d1", "discarded")];
    expect(draftView(ticket, waiting, ask, false)).toEqual({ kind: "writing" });
    expect(waitingOn(ticket, ask)(waiting)).toBe(true);

    const arrived = [...waiting, draft("d2", "pending")];
    expect(draftView(ticket, arrived, ask, false)).toMatchObject({ kind: "draft" });
    expect(waitingOn(ticket, ask)(arrived)).toBe(false);
  });

  it("forgets an ask once the draft it brought is discarded too", () => {
    const drafts = [draft("d1", "discarded"), draft("d2", "discarded")];
    expect(draftView(ticket, drafts, { replacing: "d1" }, false)).toEqual({
      kind: "choose",
      after: "discarded",
    });
  });

  it("keeps a reply being written on screen, and says so, when a pending draft arrives", () => {
    expect(draftView(ticket, [draft("d1", "pending")], undefined, true)).toEqual({
      kind: "compose",
      meanwhile: "drafted",
    });
  });

  it("says when the message was answered while the reply was being written", () => {
    expect(draftView(ticket, [draft("d1", "sent")], undefined, true)).toEqual({
      kind: "compose",
      meanwhile: "answered",
    });
  });

  it("offers the choice on a ticket the AI budget paused, and waits once asked", () => {
    const paused: TicketDetail = { ...ticket, aiPausedReason: "daily_budget" };
    expect(draftView(paused, [], undefined, false)).toEqual({ kind: "choose", after: "ai_paused" });
    expect(draftView(paused, [], { replacing: null }, false)).toEqual({ kind: "writing" });
  });

  it("offers the choice when every try to draft failed, instead of waiting for a draft", () => {
    const failed: TicketDetail = { ...ticket, aiPausedReason: "draft_failed" };
    expect(draftView(failed, [], undefined, false)).toEqual({
      kind: "choose",
      after: "draft_failed",
    });
    expect(waitingOn(failed, undefined)([])).toBe(false);
    expect(draftView(failed, [], { replacing: null }, false)).toEqual({ kind: "writing" });
  });

  it("says when a reply failed to send while the person was writing", () => {
    expect(draftView(ticket, [draft("d1", "send_failed")], undefined, true)).toEqual({
      kind: "compose",
      meanwhile: "send_failed",
    });
  });

  it("keeps a reply being written on screen when the ticket is closed meanwhile", () => {
    const closed: TicketDetail = { ...ticket, status: "closed" };
    expect(draftView(closed, [draft("d1", "discarded")], undefined, true)).toEqual({
      kind: "compose",
      meanwhile: undefined,
    });
  });

  it("offers the choice when the AI paused on a follow-up to an answered message", () => {
    const followUp: TicketDetail = {
      ...ticket,
      aiPausedReason: "daily_budget",
      messages: [inbound("m1"), inbound("m2")],
    };
    const drafts = [{ ...draft("d1", "sent"), messageId: "m1" }];
    expect(draftView(followUp, drafts, undefined, false)).toEqual({
      kind: "choose",
      after: "ai_paused",
    });
  });

  it("still shows the sent reply when it answers the latest message", () => {
    const answered: TicketDetail = {
      ...ticket,
      aiPausedReason: "daily_budget",
      messages: [inbound("m1")],
    };
    const drafts = [{ ...draft("d1", "sent"), messageId: "m1" }];
    expect(draftView(answered, drafts, undefined, false)).toMatchObject({ kind: "draft" });
  });

  it("shows nothing on a closed ticket with no draft", () => {
    const closed: TicketDetail = { ...ticket, status: "closed" };
    expect(draftView(closed, [draft("d1", "discarded")], undefined, false)).toEqual({
      kind: "none",
    });
  });
});

describe("liveFixNotice", () => {
  it("still shows an earlier fix notice when a newer one was withdrawn", () => {
    const drafts = [draft("f1", "sent", "fixed"), draft("f2", "discarded", "fixed")];
    expect(liveFixNotice(drafts)?.id).toBe("f1");
  });

  it("isn't affected by replies", () => {
    expect(liveFixNotice([draft("d1", "pending")])).toBeUndefined();
  });
});

describe("newDraftError", () => {
  it.each(["daily_budget_reached", "already_answered", "nothing_to_answer", "not_found"])(
    "doesn't tell the person to retry a refusal that a retry can't fix (%s)",
    (code) => {
      expect(newDraftError(code)).not.toMatch(/try again/i);
    },
  );
});
