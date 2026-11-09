import { describe, expect, it } from "vitest";
import { countDraftOutcomes, type DraftEdit, type DraftFact } from "./draft-outcomes.ts";

const draft = (id: string, status: DraftFact["status"]): DraftFact => ({ id, status });
const edit = (draftId: string, actorType: DraftEdit["actorType"] = "user"): DraftEdit => ({
  draftId,
  actorType,
});

describe("countDraftOutcomes", () => {
  it("counts an approved draft nobody edited as unchanged, sent or not", () => {
    expect(countDraftOutcomes([draft("a", "approved"), draft("b", "sent")], [])).toEqual({
      approvedUnchanged: 2,
      approvedEdited: 0,
      discarded: 0,
      pending: 0,
      unchangedRate: 1,
    });
  });

  it("counts a draft edited once or several times as one edited draft", () => {
    const result = countDraftOutcomes(
      [draft("once", "sent"), draft("many", "approved"), draft("clean", "sent")],
      [edit("once"), edit("many"), edit("many"), edit("many")],
    );
    expect(result).toMatchObject({ approvedUnchanged: 1, approvedEdited: 2 });
    expect(result.unchangedRate).toBeCloseTo(1 / 3);
  });

  it("counts an edit by an agent the same as one by a human", () => {
    const byAgent = countDraftOutcomes([draft("a", "sent")], [edit("a", "agent")]);
    const byHuman = countDraftOutcomes([draft("a", "sent")], [edit("a", "user")]);
    expect(byAgent).toEqual(byHuman);
    expect(byAgent).toMatchObject({ approvedUnchanged: 0, approvedEdited: 1, unchangedRate: 0 });
  });

  it("keeps discarded and pending drafts out of the rate, edited or not", () => {
    const result = countDraftOutcomes(
      [
        draft("d1", "discarded"),
        draft("d2", "discarded"),
        draft("p1", "pending"),
        draft("ok", "sent"),
      ],
      [edit("d1"), edit("p1", "agent")],
    );
    expect(result).toEqual({
      approvedUnchanged: 1,
      approvedEdited: 0,
      discarded: 2,
      pending: 1,
      unchangedRate: 1,
    });
  });

  it("has no rate when nothing was approved", () => {
    expect(countDraftOutcomes([], []).unchangedRate).toBeNull();
    expect(countDraftOutcomes([draft("p", "pending")], []).unchangedRate).toBeNull();
  });

  it("ignores edits to drafts outside the range", () => {
    expect(countDraftOutcomes([draft("a", "sent")], [edit("elsewhere")])).toMatchObject({
      approvedUnchanged: 1,
      approvedEdited: 0,
    });
  });
});
