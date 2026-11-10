import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSecretBox } from "../secrets/secret-box.ts";
import { keepsWebhookSecret } from "./integration.ts";

const tenantId = "00000000-0000-4000-8000-0000000000a1";
const box = createSecretBox(randomBytes(32));
const sealed = box.seal("hook-secret", { tenantId, purpose: "github-webhook-secret" });
const current = { repo: "acme/app", webhookSecretCiphertext: sealed };

describe("keepsWebhookSecret (does connecting again keep the webhook's secret?)", () => {
  it("keeps it for the same repo, e.g. with a new token", () => {
    expect(keepsWebhookSecret(box, tenantId, current, { repo: "acme/app", rotate: false })).toBe(
      true,
    );
  });

  it("makes a new one for the first connection", () => {
    expect(keepsWebhookSecret(box, tenantId, undefined, { repo: "acme/app", rotate: false })).toBe(
      false,
    );
  });

  it("makes a new one for another repo, which needs a webhook of its own", () => {
    expect(keepsWebhookSecret(box, tenantId, current, { repo: "acme/other", rotate: false })).toBe(
      false,
    );
  });

  it("makes a new one when asked, e.g. after a leak", () => {
    expect(keepsWebhookSecret(box, tenantId, current, { repo: "acme/app", rotate: true })).toBe(
      false,
    );
  });

  it("makes a new one when the stored secret can't be opened with this key", () => {
    const newKey = createSecretBox(randomBytes(32));
    expect(keepsWebhookSecret(newKey, tenantId, current, { repo: "acme/app", rotate: false })).toBe(
      false,
    );
  });

  it("makes a new one when the stored secret belongs to another workspace", () => {
    const elsewhere = "00000000-0000-4000-8000-0000000000b2";
    expect(keepsWebhookSecret(box, elsewhere, current, { repo: "acme/app", rotate: false })).toBe(
      false,
    );
  });
});
