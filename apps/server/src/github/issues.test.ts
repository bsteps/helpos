import { describe, expect, it } from "vitest";
import { issueText, judgeEarlierLookup } from "./issues.ts";

const connected = { owner: "acme", name: "app" };
const other = { owner: "acme", name: "old" };
const found = { number: 7, url: "https://github.com/acme/app/issues/7" };

describe("issueText", () => {
  const written = { title: "Crash @alice", body: "see #12 and https://evil.test" };

  it("sends a person's text as written", () => {
    expect(issueText(written, "human")).toEqual(written);
  });

  it("cleans an agent's text, which may have been steered by the customer's", () => {
    const cleaned = issueText(written, "agent");
    // A mention is put in a code span, where GitHub shows it as typed and pings nobody.
    expect(cleaned.title).toBe("Crash `@alice`");
    expect(cleaned.body).not.toContain("https://evil.test");
  });
});

describe("judgeEarlierLookup (what to do after searching for a dead request's issue)", () => {
  it("adopts the issue the dead request opened", () => {
    expect(judgeEarlierLookup({ ok: true, value: found }, connected, connected)).toEqual({
      action: "adopt",
      issue: found,
    });
  });

  it("opens a new one when the search is clean and finds nothing", () => {
    expect(judgeEarlierLookup({ ok: true, value: null }, connected, connected)).toEqual({
      action: "open_new",
    });
  });

  it("stops when GitHub can't say, so the next try searches again", () => {
    const outage = { ok: false, reason: "github_unavailable", uncertain: true } as const;
    expect(judgeEarlierLookup(outage, connected, connected)).toEqual({
      action: "unknown",
      reason: "github_unavailable",
    });
    // An outage says nothing about the old repo either, even when the repo changed.
    expect(judgeEarlierLookup(outage, other, connected)).toEqual({
      action: "unknown",
      reason: "github_unavailable",
    });
  });

  it("stops on a refusal for the connected repo: the token should be fixed, not skipped", () => {
    const refused = { ok: false, reason: "token_rejected", uncertain: false } as const;
    expect(judgeEarlierLookup(refused, connected, connected)).toEqual({
      action: "unknown",
      reason: "token_rejected",
    });
  });

  it("gives up on an old repo the token can't see any more, so the conversation isn't blocked for good", () => {
    const refused = { ok: false, reason: "repo_not_found", uncertain: false } as const;
    expect(judgeEarlierLookup(refused, other, connected)).toEqual({ action: "open_new" });
  });
});
