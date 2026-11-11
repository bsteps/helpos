import { and, eq, schema, type TenantTx } from "@helpos/db";
import { type AuditContext, recordAudit } from "../audit/audit.ts";

const { conversations, messages } = schema;
type ConversationValues = typeof conversations.$inferInsert;
type MessageValues = typeof messages.$inferInsert;

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
  const [closed] = await tx
    .update(conversations)
    .set({ status: "closed" })
    .where(and(eq(conversations.id, id), eq(conversations.status, "open")))
    .returning({ id: conversations.id });
  if (!closed) return false;
  await recordAudit(tx, {
    ...context,
    action: "conversation.closed",
    target: { type: "conversation", id },
  });
  return true;
}

export async function reopenConversation(
  tx: TenantTx,
  id: string,
  receivedAt: Date,
): Promise<void> {
  await tx
    .update(conversations)
    .set({ lastMessageAt: receivedAt, status: "open", automated: false })
    .where(eq(conversations.id, id));
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
    action: reason === "daily_budget" ? "ai.paused" : "ai.draft_failed",
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
