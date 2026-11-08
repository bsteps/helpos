import { describe, expect, it } from "vitest";
import { passwordSetupLink } from "./password-link.ts";

describe("passwordSetupLink", () => {
  it("puts the token in the fragment, never the path or query", () => {
    const link = new URL(passwordSetupLink("https://help.acme.test", "abc_-123"));
    expect(link.pathname).toBe("/set-password");
    expect(link.search).toBe("");
    expect(link.hash).toBe("#token=abc_-123");
  });

  it("keeps a path in the public URL", () => {
    expect(passwordSetupLink("https://acme.test/helpdesk", "t")).toBe(
      "https://acme.test/helpdesk/set-password#token=t",
    );
  });
});
