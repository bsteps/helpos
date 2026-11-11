import { describe, expect, it } from "vitest";
import { quotesInternalPassage, quoteWords, sharedRuns } from "./internal-quote.ts";

const note =
  "Discount code STAFF50 gives employees 50% off. It is for employees only and must never be " +
  "given to customers. Escalate refund requests over $500 to the finance lead before replying.";

describe("quotesInternalPassage", () => {
  it.each([
    [
      "Japanese",
      "返金申請が五万円を超える場合は、回答する前に必ず経理責任者へ連絡してください。社員専用の割引コードは顧客に公開しないでください。",
    ],
    [
      "Chinese",
      "如果退款申请金额超过五千元，请在回复客户之前联系财务负责人。员工专用折扣代码只能在内部使用，绝对不能发送给客户。",
    ],
  ])("flags a verbatim %s internal note", (_, passage) => {
    expect(quotesInternalPassage(`Staff notes: ${passage}`, [passage])).toBe(true);
  });

  it.each(["お問い合わせありがとうございます", "感谢您的耐心等待"])(
    "does not flag the short shared phrase %s",
    (phrase) => {
      expect(quotesInternalPassage(phrase, [`${phrase}。STAFF50`])).toBe(false);
    },
  );

  it("flags a draft that pastes the note word for word", () => {
    const draft = `Hi Lee,\n\nStaff notes: ${note}\n\nBest,\nSupport`;
    expect(quotesInternalPassage(draft, [note])).toBe(true);
  });

  it("flags an exact 10-word run inside an otherwise original reply", () => {
    const draft =
      "Thanks for asking! I was told: escalate refund requests over $500 to the finance lead before replying.";
    expect(quotesInternalPassage(draft, [note])).toBe(true);
  });

  it("ignores case, punctuation, line breaks and curly apostrophes", () => {
    const passage = "Don't offer the loyalty voucher unless the customer's order arrived damaged.";
    const draft =
      "We DON’T offer the loyalty\nvoucher — unless the customer’s order arrived damaged!";
    expect(quotesInternalPassage(draft, [passage])).toBe(true);
  });

  it("flags a quote of any one of several passages", () => {
    const other = "Our office is closed on public holidays and weekends.";
    expect(quotesInternalPassage(`FYI: ${note}`, [other, note])).toBe(true);
  });

  it("does not flag a 9-word run (one short of the threshold)", () => {
    const draft = "Please escalate refund requests over $500 to the finance lead today.";
    // "escalate refund requests over 500 to the finance lead" is 9 words shared with the note.
    expect(sharedRuns(draft, [note])).toEqual([]);
    expect(quotesInternalPassage(draft, [note])).toBe(false);
  });

  it("does not flag a paraphrase that follows the note without quoting it", () => {
    const draft =
      "Sorry, that discount is reserved for our team. For larger refunds a colleague will check first.";
    expect(quotesInternalPassage(draft, [note])).toBe(false);
  });

  it("does not flag a near miss where one word in every 8 differs", () => {
    const draft =
      "Discount code STAFF50 gives staff 50% off. It is for staff only and must not be given to customers.";
    expect(quotesInternalPassage(draft, [note])).toBe(false);
  });

  it("does not flag long stock phrases the note happens to share", () => {
    const boilerplate =
      "If you have any questions please let us know and we will be happy to help you.";
    const internal = `Refund rule: approve under $50. ${boilerplate}`;
    const draft = `Your refund is on its way. ${boilerplate}`;
    // The shared run is long, but it's all function words and support boilerplate.
    expect(sharedRuns(draft, [internal]).length).toBeGreaterThan(0);
    expect(quotesInternalPassage(draft, [internal])).toBe(false);
  });

  it("does not flag a short line the note tells the draft to say", () => {
    const runbook =
      "Tell them a teammate will apply it within one business day. Admin key: sk_live_123.";
    const draft = "A teammate will apply it within one business day and let you know.";
    expect(quotesInternalPassage(draft, [runbook])).toBe(false);
  });

  it("does not flag short common phrases", () => {
    const internal = "Thank you for your patience. Let us know if you need anything else.";
    expect(quotesInternalPassage("Thank you for your patience!", [internal])).toBe(false);
    expect(quotesInternalPassage("Let us know if you need anything else.", [internal])).toBe(false);
  });

  it("is false with no internal passages, or an empty draft", () => {
    expect(quotesInternalPassage(note, [])).toBe(false);
    expect(quotesInternalPassage("", [note])).toBe(false);
  });
});

describe("sharedRuns", () => {
  it("merges overlapping matches into one run", () => {
    const passage = "one two three four five six seven eight nine ten eleven twelve";
    expect(sharedRuns(`x ${passage} y`, [passage])).toEqual([quoteWords(passage)]);
  });
});
