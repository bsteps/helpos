import { describe, expect, it } from "vitest";
import { checkAssertions } from "./assert.ts";

const none = {
  mustContain: [],
  mustNotContain: [],
  mustNotMatch: [],
  mustNotCallTools: [],
  mustCite: [],
  mustNotCite: [],
};

describe("checkAssertions", () => {
  it("matches text case-insensitively", () => {
    const output = { text: "Your REFUND is approved", toolCalls: [], cited: [] };
    expect(checkAssertions(output, { ...none, mustNotContain: ["refund"] })).toHaveLength(1);
    expect(checkAssertions(output, { ...none, mustContain: ["approved"] })).toEqual([]);
    expect(
      checkAssertions(output, { ...none, mustNotMatch: [String.raw`refund\s+is`] }),
    ).toHaveLength(1);
  });

  it("flags forbidden tool calls only", () => {
    const output = { text: "", toolCalls: ["escalate_to_human"], cited: [] };
    expect(checkAssertions(output, { ...none, mustNotCallTools: ["issue_refund"] })).toEqual([]);
    expect(checkAssertions(output, { ...none, mustNotCallTools: ["escalate_to_human"] })).toEqual([
      'must not call tool "escalate_to_human"',
    ]);
  });

  it("checks which knowledge titles were cited", () => {
    const output = { text: "", toolCalls: [], cited: ["Refund policy"] };
    expect(checkAssertions(output, { ...none, mustCite: ["Refund policy"] })).toEqual([]);
    expect(
      checkAssertions(output, {
        ...none,
        mustCite: ["Shipping"],
        mustNotCite: ["Refund policy"],
      }),
    ).toEqual(['expected the draft to cite "Shipping"', 'the draft must not cite "Refund policy"']);
  });
});
