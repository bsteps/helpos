import { schema } from "@helpos/db";
import { expect, it } from "vitest";
import { draftWorkerActor } from "../drafts/draft-worker.ts";
import { noticeWorkerActor } from "../drafts/notice-worker.ts";
import { sendWorkerActor } from "../drafts/send-worker.ts";

it("preserves the stored actor types and built-in audit identities", () => {
  expect(schema.actorTypes).toEqual(["user", "agent", "system"]);
  expect([draftWorkerActor, noticeWorkerActor, sendWorkerActor]).toEqual([
    { type: "system", id: "draft-reply" },
    { type: "system", id: "draft-notice" },
    { type: "system", id: "send-reply" },
  ]);
});
