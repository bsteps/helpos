import { createHash } from "node:crypto";
import { z } from "zod";

const bodyHash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.uuid();
const empty = z.strictObject({});

const discardDetails = z.discriminatedUnion("reason", [
  z.strictObject({
    reason: z.literal("manual"),
    operation: z.enum(["discard", "regenerate", "replace"]),
  }),
  z.strictObject({ reason: z.literal("superseded"), newerMessageId: id }),
  z.strictObject({ reason: z.literal("issue_reopened") }),
]);

export const auditDetails = {
  "draft.created": z.strictObject({ bodyHash, messageId: id, kind: z.enum(["reply", "fixed"]) }),
  "draft.edited": z.strictObject({ oldBodyHash: bodyHash, newBodyHash: bodyHash }),
  "draft.approved": z.strictObject({ reviewedBodyHash: bodyHash }),
  "draft.discarded": discardDetails,
  "draft.send_rejected": z.strictObject({
    fromStatus: z.literal("send_uncertain"),
    toStatus: z.enum(["approved", "send_uncertain"]),
  }),
  "draft.sending": z.strictObject({
    fromStatus: z.enum(["approved", "send_uncertain"]),
    toStatus: z.literal("send_uncertain"),
  }),
  "draft.send_confirmed": z.strictObject({
    fromStatus: z.literal("send_uncertain"),
    toStatus: z.literal("sent"),
  }),
  "draft.sent": z.strictObject({
    fromStatus: z.literal("send_uncertain"),
    toStatus: z.literal("sent"),
  }),
  "draft.send_failed": z.strictObject({
    fromStatus: z.literal("approved"),
    toStatus: z.literal("send_failed"),
  }),
  "draft.send_retried": z.strictObject({
    reason: z.enum(["retry_failed", "requeue_approved", "resend_uncertain"]),
  }),
  "draft.notice_sent": z.strictObject({ draftId: id }),
  "draft.notice_failed": z.strictObject({ draftId: id }),
  "conversation.closed": empty,
  "ai.paused": empty,
  "ai.draft_failed": empty,
  "knowledge_source.created": empty,
  "knowledge_source.deleted": empty,
  "knowledge_source.edited": empty,
  "knowledge_source.made_public": empty,
  "knowledge_source.made_internal": empty,
  "knowledge_source.reingest_requested": empty,
  "knowledge_source.ingested": empty,
  "knowledge_source.failed": empty,
  "workspace.shadow_mode_enabled": empty,
  "workspace.shadow_mode_disabled": empty,
  "workspace.shadow_recipient_changed": empty,
  "workspace.ai_budget_changed": empty,
  "api_token.created": empty,
  "api_token.revoked": empty,
  "github.connected": empty,
  "github.disconnected": empty,
  "github.webhook_secret_rotated": empty,
  "github_issue.drafted": empty,
  "github_issue.created": empty,
  "github_issue.closed": empty,
  "github_issue.reopened": empty,
  "github_issue.recheck_failed": empty,
};

export type AuditAction = keyof typeof auditDetails;
export type Details<A extends AuditAction> = z.infer<(typeof auditDetails)[A]>;
export type DiscardDetails = z.infer<typeof discardDetails>;

export function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}
