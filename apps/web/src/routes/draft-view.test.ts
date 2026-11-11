import { describe, expect, it } from "vitest";
import type { ConversationDetail, Draft } from "@/api/client.ts";
import {
  draftDescription,
  draftTitle,
  draftView,
  liveFixNotice,
  newDraftError,
  waitingOn,
} from "./draft-view.ts";

const conversation: ConversationDetail = {
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
    conversationId: conversation.id,
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

function inbound(id: string): ConversationDetail["messages"][number] {
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
    expect(draftView(conversation, drafts, undefined, false)).toEqual({
      kind: "choose",
      after: "discarded",
    });
    expect(waitingOn(conversation, undefined)(drafts)).toBe(false);
  });

  it("says a reply that failed to send was discarded", () => {
    expect(draftView(conversation, [failedThenDiscarded("d1")], undefined, false)).toEqual({
      kind: "choose",
      after: "send_failed",
    });
  });

  it("doesn't bring back an older sent reply when the newest one was discarded", () => {
    const drafts = [draft("d1", "sent"), draft("d2", "discarded")];
    expect(draftView(conversation, drafts, undefined, false).kind).toBe("choose");
  });

  it("waits for an asked-for draft, then shows it when it arrives", () => {
    const ask = { replacing: "d1" };
    const waiting = [draft("d1", "discarded")];
    expect(draftView(conversation, waiting, ask, false)).toEqual({ kind: "writing" });
    expect(waitingOn(conversation, ask)(waiting)).toBe(true);

    const arrived = [...waiting, draft("d2", "pending")];
    expect(draftView(conversation, arrived, ask, false)).toMatchObject({ kind: "draft" });
    expect(waitingOn(conversation, ask)(arrived)).toBe(false);
  });

  it("forgets an ask once the draft it brought is discarded too", () => {
    const drafts = [draft("d1", "discarded"), draft("d2", "discarded")];
    expect(draftView(conversation, drafts, { replacing: "d1" }, false)).toEqual({
      kind: "choose",
      after: "discarded",
    });
  });

  it("keeps a reply being written on screen, and says so, when a pending draft arrives", () => {
    expect(draftView(conversation, [draft("d1", "pending")], undefined, true)).toEqual({
      kind: "compose",
      meanwhile: "drafted",
    });
  });

  it("says when the message was answered while the reply was being written", () => {
    expect(draftView(conversation, [draft("d1", "sent")], undefined, true)).toEqual({
      kind: "compose",
      meanwhile: "answered",
    });
  });

  it("offers the choice on a conversation the AI budget paused, and waits once asked", () => {
    const paused: ConversationDetail = { ...conversation, aiPausedReason: "daily_budget" };
    expect(draftView(paused, [], undefined, false)).toEqual({ kind: "choose", after: "ai_paused" });
    expect(draftView(paused, [], { replacing: null }, false)).toEqual({ kind: "writing" });
  });

  it("offers the choice when every try to draft failed, instead of waiting for a draft", () => {
    const failed: ConversationDetail = { ...conversation, aiPausedReason: "draft_failed" };
    expect(draftView(failed, [], undefined, false)).toEqual({
      kind: "choose",
      after: "draft_failed",
    });
    expect(waitingOn(failed, undefined)([])).toBe(false);
    expect(draftView(failed, [], { replacing: null }, false)).toEqual({ kind: "writing" });
  });

  it("shows a new failure of an ask that was queued, not a spinner", () => {
    // `queued`: the server accepted the ask and cleared the old `draft_failed`, and the conversation
    // was fetched again. A `draft_failed` after that is the asked-for draft failing too.
    const failed: ConversationDetail = { ...conversation, aiPausedReason: "draft_failed" };
    expect(draftView(failed, [], { replacing: null, queued: true }, false)).toEqual({
      kind: "choose",
      after: "draft_failed",
    });
    // Not yet queued, the conversation may still be the one from before the ask.
    expect(draftView(failed, [], { replacing: null, queued: false }, false)).toEqual({
      kind: "writing",
    });
    // Queued and nothing failed yet: still waiting, and still polling.
    expect(draftView(conversation, [], { replacing: null, queued: true }, false)).toEqual({
      kind: "writing",
    });
    expect(waitingOn(conversation, { replacing: null, queued: true })([])).toBe(true);
  });

  it("says when a reply failed to send while the person was writing", () => {
    expect(draftView(conversation, [draft("d1", "send_failed")], undefined, true)).toEqual({
      kind: "compose",
      meanwhile: "send_failed",
    });
  });

  it("keeps a reply being written on screen when the conversation is closed meanwhile", () => {
    const closed: ConversationDetail = { ...conversation, status: "closed" };
    expect(draftView(closed, [draft("d1", "discarded")], undefined, true)).toEqual({
      kind: "compose",
      meanwhile: undefined,
    });
  });

  it("offers the choice when the AI paused on a follow-up to an answered message", () => {
    const followUp: ConversationDetail = {
      ...conversation,
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
    const answered: ConversationDetail = {
      ...conversation,
      aiPausedReason: "daily_budget",
      messages: [inbound("m1")],
    };
    const drafts = [{ ...draft("d1", "sent"), messageId: "m1" }];
    expect(draftView(answered, drafts, undefined, false)).toMatchObject({ kind: "draft" });
  });

  it("shows nothing on a closed conversation with no draft", () => {
    const closed: ConversationDetail = { ...conversation, status: "closed" };
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
  it.each([
    "daily_budget_reached",
    "already_answered",
    "nothing_to_answer",
    "conversation_closed",
    "not_found",
  ])("doesn't tell the person to retry a refusal that a retry can't fix (%s)", (code) => {
    expect(newDraftError(code)).not.toMatch(/try again/i);
  });
});

describe("draft card copy", () => {
  it.each(["reply", "fixed"] as const)("titles and descriptions for every %s state", (kind) => {
    const cases = [
      ["pending", "Draft", "Nothing is sent until you approve it."],
      ["approved", "Reply", "Approved. It goes out in a moment."],
      ["send_failed", "Reply", "Approved, but it couldn't be sent."],
      ["discarded", "Reply", "Approved. It goes out in a moment."],
      ["sent", "Reply", "Approved. It goes out in a moment."],
    ] satisfies [Draft["status"], string, string][];
    for (const [status, title, description] of cases) {
      const value = { kind, status, sentAt: null };
      expect(draftTitle(value)).toBe(kind === "fixed" ? "Fix notice" : title);
      expect(draftDescription(value)).toBe(
        kind === "fixed" && status === "pending"
          ? "The GitHub issue was closed as done. Nothing is sent until you approve it."
          : description,
      );
    }
  });

  it.each(["reply", "fixed"] as const)(
    "a %s sent timestamp takes precedence over status",
    (kind) => {
      const statuses: Draft["status"][] = [
        "pending",
        "approved",
        "sent",
        "send_failed",
        "discarded",
      ];
      const formatted = new Date(sentAt).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
      for (const status of statuses) {
        expect(draftDescription({ kind, status, sentAt })).toBe(`Sent ${formatted}`);
      }
    },
  );
});
