import type { Draft, TicketDetail } from "@/api/client.ts";

export function newestReply(drafts: Draft[]): Draft | undefined {
  return drafts.filter((d) => d.kind === "reply").at(-1);
}

/** The fix notice to show: the newest one that wasn't withdrawn. Replies don't affect it. */
export function liveFixNotice(drafts: Draft[]): Draft | undefined {
  return drafts.filter((d) => d.kind === "fixed" && d.status !== "discarded").at(-1);
}

/** A new AI draft was asked for while this reply was the newest (`null`: there was none). */
export type Ask = { replacing: string | null };

/** What happened to the reply while a person was writing their own. */
export type Meanwhile = "drafted" | "answered" | "send_failed";

const meanwhileByStatus: Record<Draft["status"], Meanwhile | undefined> = {
  pending: "drafted",
  approved: "answered",
  sent: "answered",
  send_failed: "send_failed",
  discarded: undefined,
};

export type DraftView =
  | { kind: "none" }
  | { kind: "draft"; draft: Draft }
  | { kind: "writing" }
  | { kind: "compose"; meanwhile: Meanwhile | undefined }
  | { kind: "choose"; after: "discarded" | "send_failed" | "ai_paused" };

export function draftView(
  ticket: TicketDetail | undefined,
  drafts: Draft[],
  ask: Ask | undefined,
  composing: boolean,
): DraftView {
  const newest = newestReply(drafts);
  // Once the newest reply is discarded, an older sent reply isn't the one to show.
  const live = newest?.status === "discarded" ? undefined : newest;
  // A reply being written stays on screen whatever changes meanwhile, so typed text isn't lost.
  if (composing) {
    return { kind: "compose", meanwhile: live && meanwhileByStatus[live.status] };
  }
  if (live) return { kind: "draft", draft: live };
  if (ticket?.status !== "open" || ticket.automated) return { kind: "none" };
  if (ask && ask.replacing === (newest?.id ?? null)) return { kind: "writing" };
  if (newest) return { kind: "choose", after: newest.approvedAt ? "send_failed" : "discarded" };
  if (ticket.aiPausedReason) return { kind: "choose", after: "ai_paused" };
  return { kind: "writing" };
}

/** Whether to keep checking for a draft: one is being written, or an approved one is sending. */
export function waitingOn(ticket: TicketDetail | undefined, ask: Ask | undefined) {
  return (drafts: Draft[]): boolean =>
    // An approved draft still goes out after the ticket is closed: keep watching until it's sent.
    drafts.some((d) => d.status === "approved") ||
    draftView(ticket, drafts, ask, false).kind === "writing";
}

/** What to tell the person when asking for or saving a new draft fails, by API error code. */
export function newDraftError(code: string | undefined): string {
  switch (code) {
    case "daily_budget_reached":
      return "Today's AI budget is spent, so the AI can't write a draft until midnight UTC. You can write one yourself.";
    case "already_answered":
      return "The customer's latest message already has a reply that was approved or sent.";
    case "nothing_to_answer":
      return "There's no customer message to answer.";
    case "not_found":
      return "This ticket is gone, or you no longer have access to it.";
    default:
      return "That didn't work. Try again.";
  }
}
