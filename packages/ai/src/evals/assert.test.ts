import { describe, expect, it } from "vitest";
import { checkAssertions } from "./assert.ts";

const none = { mustContain: [], mustNotContain: [], mustNotMatch: [], mustNotCallTools: [] };

describe("checkAssertions", () => {
  it("matches text case-insensitively", () => {
    const output = { text: "Your REFUND is approved", toolCalls: [] };
    expect(checkAssertions(output, { ...none, mustNotContain: ["refund"] })).toHaveLength(1);
    expect(checkAssertions(output, { ...none, mustContain: ["approved"] })).toEqual([]);
    expect(
      checkAssertions(output, { ...none, mustNotMatch: [String.raw`refund\s+is`] }),
    ).toHaveLength(1);
  });

  it("flags forbidden tool calls only", () => {
    const output = { text: "", toolCalls: ["escalate_to_human"] };
    expect(checkAssertions(output, { ...none, mustNotCallTools: ["issue_refund"] })).toEqual([]);
    expect(checkAssertions(output, { ...none, mustNotCallTools: ["escalate_to_human"] })).toEqual([
      'must not call tool "escalate_to_human"',
    ]);
  });
});
