import {
  and,
  type Database,
  desc,
  enqueue,
  eq,
  inArray,
  isUniqueViolation,
  schema,
  sql,
  type TenantTx,
  uuidv7,
} from "@helpos/db";
import type { FileStore } from "@helpos/files";
import { draftReplyJob } from "../drafts/jobs.ts";
import { type ParsedEmail, parseEmail } from "./parse.ts";

const { attachments, customers, messages, conversations } = schema;

export type IngestResult =
  /** No recipient matches a mailbox. Nothing was stored. */
  | { kind: "unroutable" }
  /** The email has no usable From address. Nothing was stored. */
  | { kind: "invalid"; reason: "missing_from" }
  /** This Message-ID was already stored for the workspace (a provider retry). */
  | { kind: "duplicate"; conversationId: string; messageId: string }
  | {
      kind: "created";
      conversationId: string;
      messageId: string;
      threaded: boolean;
      /** True when a draft-reply job was queued. False for machine-sent mail. */
      draftReply: boolean;
    };

export interface IngestDeps {
  db: Pick<Database, "withTenant" | "resolveMailbox">;
  files: FileStore;
}

/**
 * Turns a raw inbound email into a conversation message in the right workspace. The content is
 * stored as data and never acted on (ADR 0004).
 */
export async function ingestEmail(deps: IngestDeps, raw: Uint8Array): Promise<IngestResult> {
  const email = await parseEmail(raw);

  const route = await findRoute(deps.db, email.recipients);
  if (!route) return { kind: "unroutable" };
  const from = email.from;
  if (!from) return { kind: "invalid", reason: "missing_from" };

  try {
    return await deps.db.withTenant(route.tenantId, (tx) =>
      store(
        tx,
        deps.files,
        { tenantId: route.tenantId, mailboxId: route.mailboxId },
        email,
        from,
        raw,
      ),
    );
  } catch (error) {
    // Two deliveries of the same email raced past the duplicate check: the loser reports
    // the winner's message instead of failing.
    if (email.messageId && isUniqueViolation(error, "messages_tenant_message_id")) {
      const existing = await deps.db.withTenant(route.tenantId, (tx) =>
        findByMessageId(tx, email.messageId ?? ""),
      );
      if (existing) return { kind: "duplicate", ...existing };
    }
    throw error;
  }
}

async function findRoute(db: IngestDeps["db"], recipients: string[]) {
  for (const address of recipients) {
    const route = await db.resolveMailbox(address);
    if (route) return route;
  }
  return null;
}

async function store(
  tx: TenantTx,
  files: FileStore,
  route: { tenantId: string; mailboxId: string },
  email: ParsedEmail,
  from: NonNullable<ParsedEmail["from"]>,
  raw: Uint8Array,
): Promise<IngestResult> {
  const { tenantId } = route;

  if (email.messageId) {
    const existing = await findByMessageId(tx, email.messageId);
    if (existing) return { kind: "duplicate", ...existing };
  }

  const customerId = await upsertCustomer(tx, tenantId, from);
  const threadConversationId = await findThread(tx, customerId, email.threadIds);
  const now = new Date();

  let conversationId: string;
  if (threadConversationId) {
    conversationId = threadConversationId;
    await tx
      .update(conversations)
      // An out-of-office reply to a closed conversation must not reopen it. A person writing on a
      // conversation a machine opened (e.g. answering a bounce) makes it a normal conversation.
      .set(
        email.automated
          ? { lastMessageAt: now }
          : { lastMessageAt: now, status: "open", automated: false },
      )
      .where(eq(conversations.id, conversationId));
  } else {
    conversationId = uuidv7();
    await tx.insert(conversations).values({
      id: conversationId,
      tenantId,
      customerId,
      mailboxId: route.mailboxId,
      subject: email.subject,
      lastMessageAt: now,
      automated: email.automated !== null,
    });
  }

  // Keys are generated here, never taken from the email. Bytes are written before the rows
  // that point at them; if the transaction then fails, a file is orphaned but nothing dangles.
  const rawFileKey = `${tenantId}/${uuidv7()}`;
  await files.put(rawFileKey, raw);

  const messageId = uuidv7();
  await tx.insert(messages).values({
    id: messageId,
    tenantId,
    conversationId,
    direction: "inbound",
    fromAddress: from.address,
    fromName: from.name,
    toAddresses: email.to,
    subject: email.subject,
    textBody: email.text,
    htmlBody: email.html,
    messageIdHeader: email.messageId,
    inReplyTo: email.inReplyTo,
    references: email.references,
    rawFileKey,
    sentAt: email.date,
    automatedReason: email.automated,
  });

  for (const attachment of email.attachments) {
    const fileKey = `${tenantId}/${uuidv7()}`;
    await files.put(fileKey, attachment.bytes);
    await tx.insert(attachments).values({
      tenantId,
      messageId,
      filename: attachment.filename,
      contentType: attachment.contentType,
      contentId: attachment.contentId,
      sizeBytes: attachment.bytes.byteLength,
      fileKey,
    });
  }

  // Same transaction as the message: the job exists exactly when the message does.
  const draftReply = email.automated === null;
  if (draftReply) {
    await enqueue(tx, draftReplyJob, { tenantId, messageId }, { singletonKey: messageId });
  }

  return {
    kind: "created",
    conversationId,
    messageId,
    threaded: threadConversationId !== null,
    draftReply,
  };
}

async function findByMessageId(tx: TenantTx, messageIdHeader: string) {
  const rows = await tx
    .select({ conversationId: messages.conversationId, messageId: messages.id })
    .from(messages)
    .where(eq(messages.messageIdHeader, messageIdHeader))
    .limit(1);
  return rows[0] ?? null;
}

async function upsertCustomer(
  tx: TenantTx,
  tenantId: string,
  from: NonNullable<ParsedEmail["from"]>,
): Promise<string> {
  const rows = await tx
    .insert(customers)
    .values({ tenantId, email: from.address, name: from.name })
    .onConflictDoUpdate({
      target: [customers.tenantId, customers.email],
      // The first name we saw wins: a later email (From is unverified until #31) must not be
      // able to rename an existing customer. It only fills in a missing name.
      set: { name: sql`coalesce(${customers.name}, excluded.name)` },
    })
    .returning({ id: customers.id });
  const customer = rows[0];
  if (!customer) throw new Error("upsertCustomer: no row returned");
  return customer.id;
}

/**
 * The conversation this email replies to, if any. Only the same customer's conversations count: a
 * Message-ID alone must not let a stranger add messages to someone else's conversation.
 */
async function findThread(
  tx: TenantTx,
  customerId: string,
  threadIds: string[],
): Promise<string | null> {
  if (threadIds.length === 0) return null;
  const rows = await tx
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(inArray(messages.messageIdHeader, threadIds), eq(conversations.customerId, customerId)),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return rows[0]?.conversationId ?? null;
}
