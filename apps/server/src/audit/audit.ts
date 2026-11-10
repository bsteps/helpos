import { AsyncLocalStorage } from "node:async_hooks";
import { schema, type TenantTx } from "@helpos/db";

export type AuditActor = { type: "user" | "agent" | "system"; id: string };

export interface AuditEvent {
  tenantId: string;
  actor: AuditActor;
  action:
    | "draft.created"
    | "draft.edited"
    | "draft.approved"
    | "draft.discarded"
    | "draft.sent"
    | "draft.send_failed"
    | "draft.send_retried"
    | "draft.notice_sent"
    | "draft.notice_failed"
    | "ticket.closed"
    | "ai.paused"
    | "ai.draft_failed"
    | "knowledge_source.created"
    | "knowledge_source.deleted"
    | "knowledge_source.edited"
    | "knowledge_source.made_public"
    | "knowledge_source.made_internal"
    | "knowledge_source.reingest_requested"
    | "knowledge_source.ingested"
    | "knowledge_source.failed"
    | "workspace.shadow_mode_enabled"
    | "workspace.shadow_mode_disabled"
    | "workspace.shadow_recipient_changed"
    | "workspace.ai_budget_changed"
    | "api_token.created"
    | "api_token.revoked"
    | "github.connected"
    | "github.disconnected"
    | "github.webhook_secret_rotated"
    | "github_issue.drafted"
    | "github_issue.created"
    | "github_issue.closed"
    | "github_issue.reopened"
    | "github_issue.recheck_failed";
  target: {
    type: "draft" | "ticket" | "knowledge_source" | "workspace" | "api_token" | "integration";
    id: string;
  };
  /** The HTTP request ID, or null when a background job acts. */
  requestId: string | null;
}

export type AuditAction = AuditEvent["action"];

/** What one request has audited so far. Set by the route's middleware; see `apiRoute()`. */
export interface AuditTrail {
  readonly recorded: Set<AuditAction>;
  nothingChanged: boolean;
}

export const auditTrail = new AsyncLocalStorage<AuditTrail>();

/**
 * Says a write request succeeded without changing anything (closing a closed ticket, say),
 * so it has no audit event to record. Without it, such a success fails the request's audit
 * check. The reason is for the reader.
 */
export function nothingToAudit(_reason: string): void {
  const trail = auditTrail.getStore();
  if (trail) trail.nothingChanged = true;
}

/**
 * Appends one audit event. Takes the action's own transaction, so the event and the action
 * commit together or not at all. The table is append-only for the app role.
 */
export async function recordAudit(tx: TenantTx, event: AuditEvent): Promise<void> {
  await tx.insert(schema.auditEvents).values({
    tenantId: event.tenantId,
    actorType: event.actor.type,
    actorId: event.actor.id,
    action: event.action,
    targetType: event.target.type,
    targetId: event.target.id,
    requestId: event.requestId,
  });
  auditTrail.getStore()?.recorded.add(event.action);
}

/** Records one audit event inside the action's own transaction, for an actor fixed up front. */
export type Auditor = (
  tx: TenantTx,
  action: AuditAction,
  target: AuditEvent["target"],
) => Promise<void>;

/**
 * An `Auditor` for one actor in one workspace. A route uses `auditor(c)` from the route kit,
 * which takes all three from the request; a background job names itself here.
 */
export function auditorFor(
  tenantId: string,
  actor: AuditActor,
  requestId: string | null = null,
): Auditor {
  return (tx, action, target) => recordAudit(tx, { tenantId, actor, action, target, requestId });
}
