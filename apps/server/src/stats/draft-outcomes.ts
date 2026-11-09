import type { ActorType, DraftStatus } from "@helpos/db";

/** What the counting needs to know about one draft. */
export interface DraftFact {
  id: string;
  status: DraftStatus;
  /**
   * Whether it was ever approved. A draft whose send failed for good may be discarded
   * afterwards: it was still approved as written, so it counts as approved, not discarded.
   */
  approved: boolean;
}

/** One `draft.edited` audit event. Who made it doesn't matter, only that someone did. */
export interface DraftEdit {
  draftId: string;
  actorType: ActorType;
}

export interface DraftOutcomes {
  approvedUnchanged: number;
  approvedEdited: number;
  discarded: number;
  pending: number;
  /** approvedUnchanged ÷ (approvedUnchanged + approvedEdited); null when nothing was approved. */
  unchangedRate: number | null;
}

/**
 * Sorts drafts into outcomes. Any draft that was ever approved counts as approved: one being
 * sent, sent, failed to send (and maybe retried or discarded since). Any
 * edit, by a human or an agent, makes an approved draft "edited": the measure is whether the AI's
 * text went out as written.
 */
export function countDraftOutcomes(
  drafts: readonly DraftFact[],
  edits: readonly DraftEdit[],
): DraftOutcomes {
  const edited = new Set(edits.map((e) => e.draftId));
  const counts = { approvedUnchanged: 0, approvedEdited: 0, discarded: 0, pending: 0 };
  for (const d of drafts) {
    if (d.approved) {
      if (edited.has(d.id)) counts.approvedEdited++;
      else counts.approvedUnchanged++;
    } else if (d.status === "pending") counts.pending++;
    else counts.discarded++;
  }
  const approved = counts.approvedUnchanged + counts.approvedEdited;
  return { ...counts, unchangedRate: approved === 0 ? null : counts.approvedUnchanged / approved };
}
