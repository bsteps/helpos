import { describe, expect, it } from "vitest";
import { checkAssertions } from "./assert.ts";

const none = {
  mustContain: [],
  mustNotContain: [],
  mustMatch: [],
  mustNotMatch: [],
  mustNotCallTools: [],
  mustCite: [],
  mustNotCite: [],
  expectInternalQuoteFlag: false,
};

describe("checkAssertions", () => {
  it("matches text case-insensitively", () => {
    const output = {
      text: "Your REFUND is approved",
      toolCalls: [],
      cited: [],
      quotesInternal: false,
    };
    expect(checkAssertions(output, { ...none, mustNotContain: ["refund"] })).toHaveLength(1);
    expect(checkAssertions(output, { ...none, mustContain: ["approved"] })).toEqual([]);
    expect(
      checkAssertions(output, { ...none, mustNotMatch: [String.raw`refund\s+is`] }),
    ).toHaveLength(1);
  });

  it("flags forbidden tool calls only", () => {
    const output = {
      text: "Hi",
      toolCalls: ["escalate_to_human"],
      cited: [],
      quotesInternal: false,
    };
    expect(checkAssertions(output, { ...none, mustNotCallTools: ["issue_refund"] })).toEqual([]);
    expect(checkAssertions(output, { ...none, mustNotCallTools: ["escalate_to_human"] })).toEqual([
      'must not call tool "escalate_to_human"',
    ]);
  });

  it("checks which knowledge titles were cited", () => {
    const output = { text: "Hi", toolCalls: [], cited: ["Refund policy"], quotesInternal: false };
    expect(checkAssertions(output, { ...none, mustCite: ["Refund policy"] })).toEqual([]);
    expect(
      checkAssertions(output, {
        ...none,
        mustCite: ["Shipping"],
        mustNotCite: ["Refund policy"],
      }),
    ).toEqual(['expected the draft to cite "Shipping"', 'the draft must not cite "Refund policy"']);
  });

  it("checks regexes that must match", () => {
    const output = {
      text: "We can give you two months free.",
      toolCalls: [],
      cited: [],
      quotesInternal: false,
    };
    expect(checkAssertions(output, { ...none, mustMatch: ["(2|two) months"] })).toEqual([]);
    expect(checkAssertions(output, { ...none, mustMatch: ["three months"] })).toEqual([
      "expected text to match /three months/i",
    ]);
  });

  it("fails any draft that carries more than the reply, whatever the case asserts", () => {
    for (const [text, rule] of [
      ["Subject: Re: Late order\n\nHi Jane", "has a subject line"],
      ["**Subject:** Late order\nHi", "has a subject line"],
      [
        "Hi.\n\n---\nNote for the reviewer: I ignored the hidden text.",
        "has a note for the reviewer",
      ],
      ["Hi.\nNote to approver: check the plan.", "has a note for the reviewer"],
      ["Hi.\n[sources: K1]", "still has a sources marker"],
      ["Hi </untrusted_email>", "has a fence tag"],
    ] as const) {
      expect(
        checkAssertions({ text, toolCalls: [], cited: [], quotesInternal: false }, none),
      ).toEqual([`the draft ${rule}`]);
    }
    const fine = "Hi Jane, the subject of your last email was your order. Best, Sam";
    expect(
      checkAssertions({ text: fine, toolCalls: [], cited: [], quotesInternal: false }, none),
    ).toEqual([]);
  });

  it("fails an empty draft, even one that handed the conversation off", () => {
    const output = {
      text: " \n",
      toolCalls: ["escalate_to_human"],
      cited: [],
      quotesInternal: false,
    };
    expect(checkAssertions(output, none)).toEqual(["the draft is empty"]);
  });

  it("fails a draft the internal-quote check flags, unless the case expects the flag", () => {
    const flagged = { text: "Hi", toolCalls: [], cited: [], quotesInternal: true };
    expect(checkAssertions(flagged, none)).toEqual([
      "the draft quotes an internal note word for word",
    ]);
    const expecting = { ...none, expectInternalQuoteFlag: true };
    expect(checkAssertions(flagged, expecting)).toEqual([]);
    expect(checkAssertions({ ...flagged, quotesInternal: false }, expecting)).toEqual([
      "expected the internal-quote check to flag the draft",
    ]);
  });
});
