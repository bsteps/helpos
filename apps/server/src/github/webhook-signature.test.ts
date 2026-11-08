import { describe, expect, it } from "vitest";
import { signatureMatches, signWebhook } from "./webhook-signature.ts";

const secret = "It's a Secret to Everybody";
const body = new TextEncoder().encode("Hello, World!");

describe("webhook signature", () => {
  it("matches GitHub's documented example", () => {
    // From GitHub's "Validating webhook deliveries" docs.
    expect(signWebhook(secret, body)).toBe(
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    );
    expect(signatureMatches(secret, body, signWebhook(secret, body))).toBe(true);
  });

  it("accepts upper-case hex, but only after the exact sha256= prefix", () => {
    expect(signatureMatches(secret, body, signWebhook(secret, body).toUpperCase())).toBe(false);
    const hex = signWebhook(secret, body).slice("sha256=".length).toUpperCase();
    expect(signatureMatches(secret, body, `sha256=${hex}`)).toBe(true);
  });

  it("refuses another secret, another body, or a missing or malformed header", () => {
    const good = signWebhook(secret, body);
    expect(signatureMatches("another secret", body, good)).toBe(false);
    expect(signatureMatches(secret, new TextEncoder().encode("Hello, World?"), good)).toBe(false);
    expect(signatureMatches(secret, body, undefined)).toBe(false);
    expect(signatureMatches(secret, body, "")).toBe(false);
    expect(signatureMatches(secret, body, good.replace("sha256=", "sha1="))).toBe(false);
    expect(signatureMatches(secret, body, `${good}00`)).toBe(false);
  });
});
