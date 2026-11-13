export const actorTypes = ["user", "agent", "system"] as const;

export type Actor = {
  [Type in (typeof actorTypes)[number]]: { type: Type; id: string };
}[(typeof actorTypes)[number]];

export const builtInActors = {
  draftWorker: { type: "system", id: "draft-reply" },
  sendWorker: { type: "system", id: "send-reply" },
  noticeWorker: { type: "system", id: "draft-notice" },
  ingestWorker: { type: "system", id: "ingest-source" },
  tokenCli: { type: "system", id: "cli" },
  operatorCli: { type: "system", id: "operator-cli" },
} as const satisfies Record<string, Extract<Actor, { type: "system" }>>;

export function isHuman(actor: Actor): actor is Extract<Actor, { type: "user" }> {
  return actor.type === "user";
}
