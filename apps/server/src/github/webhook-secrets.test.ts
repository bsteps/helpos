import { describe, expect, it } from "vitest";
import { createWebhookSecrets } from "./webhook-secrets.ts";

describe("the webhook secret cache", () => {
  it("keeps a secret, or the lack of one, until it's too old or forgotten", () => {
    let now = 0;
    const secrets = createWebhookSecrets({ maxAgeMs: 1_000, max: 10, now: () => now });
    secrets.set("a", "s3cret");
    secrets.set("none", null);
    now = 400;
    expect(secrets.get("a")).toEqual({ secret: "s3cret", ageMs: 400 });
    expect(secrets.get("none")).toEqual({ secret: null, ageMs: 400 });
    secrets.forget("a");
    expect(secrets.get("a")).toBeUndefined();
    now = 1_000;
    expect(secrets.get("none")).toBeUndefined();
  });

  it("drops the oldest past its size, so a flood of made-up workspaces can't grow it", () => {
    const secrets = createWebhookSecrets({ maxAgeMs: 1_000, max: 2, now: () => 0 });
    secrets.set("a", "1");
    secrets.set("b", "2");
    secrets.set("c", "3");
    expect(secrets.get("a")).toBeUndefined();
    expect(secrets.get("c")?.secret).toBe("3");
  });
});
