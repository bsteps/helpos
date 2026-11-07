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
    | "draft.notice_sent"
    | "ai.paused"
    | "knowledge_source.created"
    | "knowledge_source.deleted"
    | "knowledge_source.reingest_requested"
    | "knowledge_source.ingested"
    | "knowledge_source.failed"
    | "workspace.shadow_mode_enabled"
    | "workspace.shadow_mode_disabled"
    | "workspace.shadow_recipient_changed"
    | "workspace.ai_budget_changed";
  target: { type: "draft" | "ticket" | "knowledge_source" | "workspace"; id: string };
  /** The HTTP request ID, or null when a background job acts. */
  requestId: string | null;
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
}
