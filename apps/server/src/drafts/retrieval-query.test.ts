import { describe, expect, it } from "vitest";
import { retrievalQuery } from "./draft-worker.ts";

describe("retrievalQuery", () => {
  it("searches with the new text only, not the quoted thread or the signature", () => {
    const body = [
      "Thanks. And how do I change my delivery address?",
      "",
      "--",
      "Jane Doe | Acme Corp | This email is confidential.",
    ].join("\n");
    expect(retrievalQuery("Re: Re: Refund", body)).toBe(
      "Refund\n\nThanks. And how do I change my delivery address?",
    );
  });

  it("stops at the quoted earlier message, and skips quoted lines", () => {
    const body = [
      "Still waiting on this.",
      "> Refunds take 5 business days.",
      "On Mon, 3 Nov 2026 at 10:00, Support <support@acme.test> wrote:",
      "> Hi Jane, refunds take 5 business days.",
    ].join("\n");
    expect(retrievalQuery("Fwd: Late refund", body)).toBe("Late refund\n\nStill waiting on this.");
  });

  it("keeps the whole body when nothing is left after the quotes", () => {
    expect(retrievalQuery("Help", "> only a quote")).toBe("Help\n\n> only a quote");
  });

  it("is cut to a bounded length", () => {
    expect(retrievalQuery("x", "y".repeat(10_000)).length).toBe(2_000);
  });
});
