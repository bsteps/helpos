import { describe, expect, expectTypeOf, it } from "vitest";
import { type Actor, type actorTypes, builtInActors, isHuman } from "./actor.ts";

describe("actors", () => {
  it.each([
    { actor: { type: "user", id: "person" }, human: true },
    { actor: { type: "agent", id: "token" }, human: false },
    { actor: { type: "system", id: "job" }, human: false },
  ] satisfies { actor: Actor; human: boolean }[])(
    "recognizes $actor.type as human=$human",
    ({ actor, human }) => {
      expect(isHuman(actor)).toBe(human);
    },
  );

  it("keeps every persisted built-in identity distinct", () => {
    expect(builtInActors).toEqual({
      draftWorker: { type: "system", id: "draft-reply" },
      sendWorker: { type: "system", id: "send-reply" },
      noticeWorker: { type: "system", id: "draft-notice" },
      githubWebhook: { type: "system", id: "github-webhook" },
      githubRecheck: { type: "system", id: "github-recheck" },
      ingestWorker: { type: "system", id: "ingest-source" },
      tokenCli: { type: "system", id: "cli" },
      operatorCli: { type: "system", id: "operator-cli" },
    });
    const ids = Object.values(builtInActors).map((actor) => actor.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses the same variants for stored types and identity narrowing", () => {
    expectTypeOf<Actor["type"]>().toEqualTypeOf<(typeof actorTypes)[number]>();
    function humanId(actor: Actor) {
      if (!isHuman(actor)) return null;
      expectTypeOf(actor.type).toEqualTypeOf<"user">();
      return actor.id;
    }
    expect(humanId({ type: "user", id: "person" })).toBe("person");
    expect(humanId(builtInActors.sendWorker)).toBeNull();
  });
});
