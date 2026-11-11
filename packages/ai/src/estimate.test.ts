import { describe, expect, it } from "vitest";
import { issueDraftTokenEstimate } from "./draft-issue.ts";
import { replyDraftTokenEstimate } from "./draft-reply.ts";
import { tokenBound } from "./estimate.ts";
import fixtures from "./fixtures/token-counts.json";

describe("token bounds against tiktoken fixtures", () => {
  it.each(fixtures.cases)("bounds $name with both encodings", ({ text, counts }) => {
    const input = { from: "sender@example.test", subject: "Support", body: text };
    for (const count of Object.values(counts)) {
      expect(tokenBound(text)).toBeGreaterThanOrEqual(count);
      expect(issueDraftTokenEstimate(input)).toBeGreaterThanOrEqual(count + 2_000);
      expect(replyDraftTokenEstimate(input)).toBeGreaterThanOrEqual(count + 1_000);
    }
  });

  it("counts separate texts and empty inputs", () => {
    expect(tokenBound()).toBe(0);
    expect(tokenBound("")).toBe(0);
    expect(tokenBound(...fixtures.cases.map(({ text }) => text))).toBe(
      fixtures.cases.reduce((sum, { text }) => sum + tokenBound(text), 0),
    );
  });
});
