import { expect, it } from "vitest";
import type { AuditEvent } from "./audit.ts";

type DetailsOptional<E> =
  Partial<Pick<E, "details" & keyof E>> extends Pick<E, "details" & keyof E> ? true : false;

it("requires details at compile time when the action's schema has required fields", () => {
  const draftCreated: DetailsOptional<AuditEvent<"draft.created">> = false;
  const draftDiscarded: DetailsOptional<AuditEvent<"draft.discarded">> = false;
  const conversationClosed: DetailsOptional<AuditEvent<"conversation.closed">> = true;
  expect([draftCreated, draftDiscarded, conversationClosed]).toEqual([false, false, true]);
});
