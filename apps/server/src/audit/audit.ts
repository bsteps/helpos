import { AsyncLocalStorage } from "node:async_hooks";
import { schema, type TenantTx } from "@helpos/db";
import type { Actor } from "@helpos/db/actor";
import { type AuditAction, auditDetails, type Details } from "./details.ts";

interface AuditEventBase<A extends AuditAction> {
  tenantId: string;
  actor: Actor;
  action: A;
  target: {
    type: "draft" | "conversation" | "knowledge_source" | "workspace" | "api_token" | "integration";
    id: string;
  };
  /** The HTTP request ID, or null when a background job acts. */
  requestId: string | null;
}

/** Details are optional only for actions whose schema accepts an empty object. */
type DetailsArgs<A extends AuditAction> =
  Record<string, never> extends Details<A> ? [details?: Details<A>] : [details: Details<A>];

export type AuditEvent<A extends AuditAction = AuditAction> = AuditEventBase<A> &
  (DetailsArgs<A> extends [details: Details<A>]
    ? { details: Details<A> }
    : { details?: Details<A> });

export type { AuditAction } from "./details.ts";

export type AuditContext = Pick<AuditEvent, "tenantId" | "actor" | "requestId">;

/** What one request has audited so far. Set by the route's middleware; see `apiRoute()`. */
export interface AuditTrail {
  readonly recorded: Set<AuditAction>;
  nothingChanged: boolean;
}

export const auditTrail = new AsyncLocalStorage<AuditTrail>();

/**
 * Says a write request succeeded without changing anything (closing a closed conversation, say),
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
export function recordAudit<A extends AuditAction>(
  tx: TenantTx,
  event: AuditEvent<A>,
): Promise<void> {
  return insertAudit(tx, event);
}

async function insertAudit(
  tx: TenantTx,
  event: AuditEventBase<AuditAction> & { details?: unknown },
): Promise<void> {
  const details = auditDetails[event.action].parse(event.details ?? {});
  await tx.insert(schema.auditEvents).values({
    tenantId: event.tenantId,
    actorType: event.actor.type,
    actorId: event.actor.id,
    action: event.action,
    targetType: event.target.type,
    targetId: event.target.id,
    requestId: event.requestId,
    details,
  });
  auditTrail.getStore()?.recorded.add(event.action);
}

/** Records one audit event inside the action's own transaction, for an actor fixed up front. */
export type Auditor = <A extends AuditAction>(
  tx: TenantTx,
  action: A,
  target: AuditEvent["target"],
  ...details: DetailsArgs<A>
) => Promise<void>;

/**
 * An `Auditor` for one actor in one workspace. A route uses `auditor(c)` from the route kit,
 * which takes all three from the request; a background job names itself here.
 */
export function auditorFor(
  tenantId: string,
  actor: Actor,
  requestId: string | null = null,
): Auditor {
  return (tx: TenantTx, action: AuditAction, target: AuditEvent["target"], details?: unknown) =>
    insertAudit(tx, { tenantId, actor, action, target, requestId, details });
}
