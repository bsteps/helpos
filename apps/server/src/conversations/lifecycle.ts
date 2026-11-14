import { and, eq, inArray, schema, type TenantTx } from "@helpos/db";
import { type AuditAction, type AuditContext, recordAudit } from "../audit/audit.ts";

const { conversations, messages } = schema;
type ConversationStatus = (typeof schema.conversationStatuses)[number];

interface Transition {
  /** The statuses a conversation may be in for this change. Anything else changes nothing. */
  readonly from: readonly ConversationStatus[];
  readonly to: ConversationStatus;
}

/** Every way a conversation's status changes, and nothing else. A new conversation is `open`. */
export const conversationTransitions = {
  close: { from: ["open"], to: "closed" },
  /** A person wrote in. Machine-sent mail never reopens a conversation (see `recordInbound`). */
  personReplied: { from: ["open", "closed"], to: "open" },
} as const satisfies Record<string, Transition>;

type ConversationOperation = keyof typeof conversationTransitions;
const pauseAudit = {
  daily_budget: "ai.paused",
  draft_failed: "ai.draft_failed",
} as const satisfies Record<schema.AiPausedReason, AuditAction>;
type ConversationValues = typeof conversations.$inferInsert;
type MessageValues = typeof messages.$inferInsert;
type ConversationSet = Omit<Partial<ConversationValues>, "status">;

async function changeStatus(
  tx: TenantTx,
  operation: ConversationOperation,
  id: string,
  set: ConversationSet = {},
): Promise<boolean> {
  const { from, to } = conversationTransitions[operation];
  const [changed] = await tx
    .update(conversations)
    .set({ ...set, status: to })
    .where(and(eq(conversations.id, id), inArray(conversations.status, [...from])))
    .returning({ id: conversations.id });
  return changed !== undefined;
}

export async function createConversation(tx: TenantTx, values: ConversationValues): Promise<void> {
  await tx.insert(conversations).values(values);
}

export async function addMessage(tx: TenantTx, values: MessageValues): Promise<void> {
  await tx.insert(messages).values(values);
}

export async function closeConversation(
  tx: TenantTx,
  context: AuditContext,
  id: string,
): Promise<boolean> {
  if (!(await changeStatus(tx, "close", id))) return false;
  await recordAudit(tx, {
    ...context,
    action: "conversation.closed",
    target: { type: "conversation", id },
  });
  return true;
}

/**
 * An inbound message on an existing conversation. A person writing reopens it and marks it as a
 * person's conversation; machine-sent mail, such as an auto-reply, only records the activity.
 */
export async function recordInbound(
  tx: TenantTx,
  id: string,
  receivedAt: Date,
  from: { automated: boolean },
): Promise<void> {
  if (from.automated) await recordActivity(tx, id, receivedAt);
  else await changeStatus(tx, "personReplied", id, { lastMessageAt: receivedAt, automated: false });
}

export async function recordActivity(tx: TenantTx, id: string, at: Date): Promise<void> {
  await tx.update(conversations).set({ lastMessageAt: at }).where(eq(conversations.id, id));
}

export async function markMessageSent(tx: TenantTx, id: string, sentAt: Date): Promise<void> {
  await tx.update(messages).set({ sentAt }).where(eq(messages.id, id));
}

export async function removeRejectedMessage(tx: TenantTx, id: string): Promise<void> {
  await tx.delete(messages).where(eq(messages.id, id));
}

export async function pauseAi(
  tx: TenantTx,
  context: AuditContext,
  id: string,
  reason: schema.AiPausedReason,
): Promise<void> {
  await tx.update(conversations).set({ aiPausedReason: reason }).where(eq(conversations.id, id));
  await recordAudit(tx, {
    ...context,
    action: pauseAudit[reason],
    target: { type: "conversation", id },
  });
}

export async function clearAiPause(
  tx: TenantTx,
  id: string,
  onlyReason?: schema.AiPausedReason,
): Promise<void> {
  await tx
    .update(conversations)
    .set({ aiPausedReason: null })
    .where(
      and(
        eq(conversations.id, id),
        onlyReason ? eq(conversations.aiPausedReason, onlyReason) : undefined,
      ),
    );
}

export async function seedConversationHistory(
  tx: TenantTx,
  history: { conversations: ConversationValues[]; messages: MessageValues[] },
): Promise<void> {
  await tx.insert(conversations).values(history.conversations).onConflictDoNothing();
  await tx.insert(messages).values(history.messages).onConflictDoNothing();
}
