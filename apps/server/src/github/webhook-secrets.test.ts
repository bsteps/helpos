import { describe, expect, it } from "vitest";
import { createWebhookSecrets } from "./webhook-secrets.ts";

describe("the webhook secret cache", () => {
  it("keeps a secret, or the lack of one, until it's too old or forgotten", () => {
    let now = 0;
    const secrets = createWebhookSecrets({ maxAgeMs: 1_000, max: 10, now: () => now });
    secrets.set("a", "s3cret", secrets.generation("a"));
    secrets.set("none", null, secrets.generation("none"));
    now = 400;
    expect(secrets.get("a")).toEqual({ secret: "s3cret", ageMs: 400 });
    expect(secrets.get("none")).toEqual({ secret: null, ageMs: 400 });
    secrets.forget("a");
    expect(secrets.get("a")).toBeUndefined();
    now = 1_000;
    expect(secrets.get("none")).toBeUndefined();
  });

  it("never stores a secret read before it was forgotten", () => {
    const secrets = createWebhookSecrets({ maxAgeMs: 1_000, max: 10, now: () => 0 });
    // A lookup starts, reading the old secret; meanwhile the admin rotates it.
    const before = secrets.generation("a");
    secrets.forget("a");
    secrets.set("a", "old", before);
    expect(secrets.get("a")).toBeUndefined();
    // A lookup begun after the rotation stores its answer.
    secrets.set("a", "new", secrets.generation("a"));
    expect(secrets.get("a")?.secret).toBe("new");
  });

  it("never lets a lookup from before a rotation store, even once that rotation is dropped", () => {
    const secrets = createWebhookSecrets({ maxAgeMs: 1_000, max: 1, now: () => 0 });
    const before = secrets.generation("a");
    secrets.forget("a");
    // Another workspace's forget pushes "a" out of the bounded list.
    secrets.forget("b");
    secrets.set("a", "old", before);
    expect(secrets.get("a")).toBeUndefined();
  });

  it("drops the oldest past its size, so a flood of made-up workspaces can't grow it", () => {
    const secrets = createWebhookSecrets({ maxAgeMs: 1_000, max: 2, now: () => 0 });
    for (const [id, secret] of [
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ] as const) {
      secrets.set(id, secret, secrets.generation(id));
    }
    expect(secrets.get("a")).toBeUndefined();
    expect(secrets.get("c")?.secret).toBe("3");
  });
});
