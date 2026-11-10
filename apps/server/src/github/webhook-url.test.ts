import { describe, expect, it } from "vitest";
import { webhookUrl } from "./webhook-url.ts";

const tenantId = "00000000-0000-4000-8000-0000000000a1";

describe("webhookUrl", () => {
  it("names the workspace in the query", () => {
    expect(webhookUrl("https://acme.test", tenantId)).toBe(
      `https://acme.test/v1/integrations/github/webhook?workspace=${tenantId}`,
    );
  });

  it("keeps a path in the public URL, with or without a trailing slash", () => {
    const expected = `https://acme.test/helpdesk/v1/integrations/github/webhook?workspace=${tenantId}`;
    expect(webhookUrl("https://acme.test/helpdesk", tenantId)).toBe(expected);
    expect(webhookUrl("https://acme.test/helpdesk/", tenantId)).toBe(expected);
  });
});
