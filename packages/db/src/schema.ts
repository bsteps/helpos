import { type SQL, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgSchema,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "./uuid.ts";

/**
 * A company using the helpdesk ("workspace" in the UI). This is the root of tenancy, so it has
 * no `tenant_id` itself. Its RLS policy lives in migration 0001.
 */
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// --- Helpers for tenant tables (ADR 0003) -----------------------------------------------------

/** Empty or unset means "no tenant", which matches no row, rather than a cast error. */
const currentTenant = sql`nullif(current_setting('app.tenant_id', true), '')::uuid`;

/**
 * The columns every tenant table starts with. A function, not a shared object: Drizzle column
 * builders must not be reused across tables.
 */
function tenantColumns() {
  return {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  };
}

/**
 * The tenant isolation policy. Declaring it makes drizzle-kit emit ENABLE ROW LEVEL SECURITY
 * and the policy. FORCE is not supported by drizzle-kit, so each new table also needs a line in
 * a hand-written migration; the catalog test in `schema.test.ts` fails if one is missing.
 */
function tenantIsolation(): ReturnType<typeof pgPolicy> {
  return pgPolicy("tenant_isolation", {
    for: "all",
    using: sql`tenant_id = ${currentTenant}`,
    withCheck: sql`tenant_id = ${currentTenant}`,
  });
}

/** Lowercase-only, so uniqueness and lookups don't depend on how a sender typed the address. */
function isLowercase(name: string, column: SQL): ReturnType<typeof check> {
  return check(name, sql`${column} = lower(${column})`);
}

// --- auth schema (ADR 0009 §1): users span tenants, so no tenant_id and no RLS ----------------

export const authSchema = pgSchema("auth");

/** A human. Only the `helpos_auth` role can read or write this table; the app role can't. */
export const users = authSchema.table(
  "users",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    email: text("email").notNull().unique(),
    name: text("name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [isLowercase("users_email_lowercase", sql`${t.email}`)],
);

// --- Tenant tables ----------------------------------------------------------------------------

/** Which workspaces a user belongs to. */
export const memberships = pgTable(
  "memberships",
  {
    ...tenantColumns(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role", { enum: ["owner", "member"] }).notNull(),
  },
  (t) => [
    unique("memberships_tenant_user").on(t.tenantId, t.userId),
    check("memberships_role", sql`${t.role} in ('owner', 'member')`),
    tenantIsolation(),
    // ADR 0009 §1: the workspace switcher lists your own memberships across tenants.
    // Read-only: writes still need the tenant policy.
    pgPolicy("own_memberships", {
      for: "select",
      using: sql`user_id = nullif(current_setting('app.user_id', true), '')::uuid`,
    }),
  ],
);

/** A support address. Inbound mail is routed to a workspace by its address. */
export const mailboxes = pgTable(
  "mailboxes",
  {
    ...tenantColumns(),
    // Globally unique: one address can only route to one workspace. ADR 0009 §7: it is only
    // written through code that reports a clash as a generic "not available".
    address: text("address").notNull().unique("mailboxes_address"),
  },
  (t) => [
    unique("mailboxes_tenant_id_id").on(t.tenantId, t.id),
    isLowercase("mailboxes_address_lowercase", sql`${t.address}`),
    tenantIsolation(),
    // Inbound routing must find the tenant before it knows the tenant. This read-only policy
    // shows exactly one row: the one whose address the caller already has.
    pgPolicy("route_by_address", {
      for: "select",
      using: sql`address = nullif(current_setting('app.mailbox_address', true), '')`,
    }),
  ],
);

/** Someone who writes in. Identified only by the From address until #31 adds SPF/DKIM/DMARC. */
export const customers = pgTable(
  "customers",
  {
    ...tenantColumns(),
    email: text("email").notNull(),
    name: text("name"),
  },
  (t) => [
    // ADR 0009 §7: per tenant, so A can't learn from an error that B has this customer.
    unique("customers_tenant_email").on(t.tenantId, t.email),
    unique("customers_tenant_id_id").on(t.tenantId, t.id),
    isLowercase("customers_email_lowercase", sql`${t.email}`),
    tenantIsolation(),
  ],
);

/** A conversation with a customer. */
export const tickets = pgTable(
  "tickets",
  {
    ...tenantColumns(),
    customerId: uuid("customer_id").notNull(),
    mailboxId: uuid("mailbox_id").notNull(),
    subject: text("subject").notNull(),
    status: text("status", { enum: ["open", "closed"] })
      .notNull()
      .default("open"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    /** Opened by machine-sent mail (out-of-office, bounce, list). Never gets an AI draft. */
    automated: boolean("automated").notNull().default(false),
    /** Why the AI skipped this ticket, e.g. `daily_budget`. Cleared when a draft is made. */
    aiPausedReason: text("ai_paused_reason", { enum: ["daily_budget"] }),
  },
  (t) => [
    unique("tickets_tenant_id_id").on(t.tenantId, t.id),
    check("tickets_status", sql`${t.status} in ('open', 'closed')`),
    check("tickets_ai_paused_reason", sql`${t.aiPausedReason} in ('daily_budget')`),
    // Composite keys: a row can never point at another tenant's row, even if RLS were off.
    foreignKey({
      name: "tickets_customer_fk",
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: "tickets_mailbox_fk",
      columns: [t.tenantId, t.mailboxId],
      foreignColumns: [mailboxes.tenantId, mailboxes.id],
    }),
    index("tickets_tenant_last_message").on(t.tenantId, t.lastMessageAt),
    tenantIsolation(),
  ],
);

/** An email on a ticket. Bodies are stored as received: data, never instructions (ADR 0004). */
export const messages = pgTable(
  "messages",
  {
    ...tenantColumns(),
    ticketId: uuid("ticket_id").notNull(),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    fromAddress: text("from_address").notNull(),
    fromName: text("from_name"),
    toAddresses: text("to_addresses").array().notNull(),
    subject: text("subject").notNull(),
    textBody: text("text_body"),
    // Untrusted HTML, exactly as sent. Anything that renders it must sanitise it first.
    htmlBody: text("html_body"),
    /** The email's own Message-ID header, used to thread replies and drop duplicate deliveries. */
    messageIdHeader: text("message_id_header"),
    inReplyTo: text("in_reply_to"),
    references: text("references").array().notNull(),
    /** Files-adapter key of the raw MIME (ADR 0002). */
    rawFileKey: text("raw_file_key").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** Why this inbound email looks machine-sent, or null for a person. Never drafted for. */
    automatedReason: text("automated_reason"),
  },
  (t) => [
    unique("messages_tenant_id_id").on(t.tenantId, t.id),
    // Per tenant (ADR 0009 §7). Postgres treats NULLs as distinct, so mail without a
    // Message-ID is never deduplicated.
    unique("messages_tenant_message_id").on(t.tenantId, t.messageIdHeader),
    check("messages_direction", sql`${t.direction} in ('inbound', 'outbound')`),
    foreignKey({
      name: "messages_ticket_fk",
      columns: [t.tenantId, t.ticketId],
      foreignColumns: [tickets.tenantId, tickets.id],
    }),
    index("messages_tenant_ticket").on(t.tenantId, t.ticketId),
    tenantIsolation(),
  ],
);

/** Attachment metadata. The bytes live in the files adapter under `fileKey`. */
export const attachments = pgTable(
  "attachments",
  {
    ...tenantColumns(),
    messageId: uuid("message_id").notNull(),
    filename: text("filename"),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    contentId: text("content_id"),
    fileKey: text("file_key").notNull(),
  },
  (t) => [
    foreignKey({
      name: "attachments_message_fk",
      columns: [t.tenantId, t.messageId],
      foreignColumns: [messages.tenantId, messages.id],
    }),
    index("attachments_tenant_message").on(t.tenantId, t.messageId),
    tenantIsolation(),
  ],
);

export const draftStatuses = ["pending", "approved", "sent", "discarded"] as const;
export type DraftStatus = (typeof draftStatuses)[number];

/**
 * An AI-written reply to one inbound message: `pending → approved → sent`, or `discarded`.
 * Only the approve endpoint moves it to `approved`, and only the send worker sends it.
 */
export const drafts = pgTable(
  "drafts",
  {
    ...tenantColumns(),
    ticketId: uuid("ticket_id").notNull(),
    /**
     * The inbound message this replies to. At most one live (not discarded) draft per message,
     * so a job retry can't add a second one.
     */
    messageId: uuid("message_id").notNull(),
    body: text("body").notNull(),
    status: text("status", { enum: draftStatuses }).notNull().default("pending"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /**
     * The Message-ID the reply is sent with, fixed at approval. A retried send reuses it, so a
     * mail server that already got the first attempt can drop the duplicate.
     */
    outboundMessageIdHeader: text("outbound_message_id_header"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** The outbound message row written when the reply was sent. */
    sentMessageId: uuid("sent_message_id"),
  },
  (t) => [
    unique("drafts_tenant_id_id").on(t.tenantId, t.id),
    uniqueIndex("drafts_tenant_message_live")
      .on(t.tenantId, t.messageId)
      .where(sql`status <> 'discarded'`),
    check("drafts_status", sql`${t.status} in ('pending', 'approved', 'sent', 'discarded')`),
    foreignKey({
      name: "drafts_ticket_fk",
      columns: [t.tenantId, t.ticketId],
      foreignColumns: [tickets.tenantId, tickets.id],
    }),
    foreignKey({
      name: "drafts_message_fk",
      columns: [t.tenantId, t.messageId],
      foreignColumns: [messages.tenantId, messages.id],
    }),
    foreignKey({
      name: "drafts_sent_message_fk",
      columns: [t.tenantId, t.sentMessageId],
      foreignColumns: [messages.tenantId, messages.id],
    }),
    index("drafts_tenant_ticket").on(t.tenantId, t.ticketId),
    tenantIsolation(),
  ],
);

export const actorTypes = ["user", "agent", "system"] as const;
export type ActorType = (typeof actorTypes)[number];

/**
 * Append-only log of every human, agent and system action, written in the same transaction as
 * the action. The app role may only INSERT and SELECT here (migration 0005).
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    actorType: text("actor_type", { enum: actorTypes }).notNull(),
    /** A user ID, an agent token's identity, or a worker name such as `draft-reply`. */
    actorId: text("actor_id").notNull(),
    /** e.g. `draft.created`, `draft.approved`. */
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    /** The HTTP request that caused it. Null for actions a background job takes. */
    requestId: text("request_id"),
  },
  (t) => [
    check("audit_events_actor_type", sql`${t.actorType} in ('user', 'agent', 'system')`),
    index("audit_events_tenant_target").on(t.tenantId, t.targetType, t.targetId),
    tenantIsolation(),
  ],
);

/**
 * AI tokens a workspace used on one UTC day, summed from the model's responses. The daily
 * budget is checked against this before every model call.
 */
export const aiUsage = pgTable(
  "ai_usage",
  {
    ...tenantColumns(),
    /** The UTC day, `YYYY-MM-DD`. A new day is a new row, which is how the budget resets. */
    day: date("day", { mode: "string" }).notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    calls: integer("calls").notNull().default(0),
  },
  (t) => [unique("ai_usage_tenant_day").on(t.tenantId, t.day), tenantIsolation()],
);

// --- Knowledge base --------------------------------------------------------------------------

/** Who owns an item's content: the app, or a file in the workspace's git repo. */
export const managedByValues = ["app", "git"] as const;
export type ManagedBy = (typeof managedByValues)[number];

/**
 * The columns every git-importable table has. Only `app` exists until git sync
 * ships, but the shape is here now, so adding git later moves no rows.
 */
function gitManageable() {
  return {
    managedBy: text("managed_by", { enum: managedByValues }).notNull().default("app"),
    /** The file it was imported from, when `managed_by = 'git'`. */
    sourcePath: text("source_path"),
    sourceCommit: text("source_commit"),
  };
}

/** A text column, so new kinds (e.g. `git`) are a check-constraint change, not a new shape. */
export const knowledgeSourceKinds = ["url", "markdown"] as const;
export type KnowledgeSourceKind = (typeof knowledgeSourceKinds)[number];
export const knowledgeSourceStatuses = ["pending", "ready", "failed"] as const;
export type KnowledgeSourceStatus = (typeof knowledgeSourceStatuses)[number];
/**
 * `public` may be shown or cited to customers (e.g. a help center). `internal` is the team's own
 * notes, such as policies and workarounds: the AI may follow it, but never quote it to customers.
 */
export const knowledgeVisibilities = ["public", "internal"] as const;
export type KnowledgeVisibility = (typeof knowledgeVisibilities)[number];

/**
 * One knowledge document: a web page to fetch or a markdown doc. The ingest job turns it into
 * `knowledge_chunks`. Its content is data, quoted to the AI, never instructions.
 */
export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    ...tenantColumns(),
    /** Stable and unique in the workspace, so it can map to a file path such as `billing/refunds`. */
    slug: text("slug").notNull(),
    kind: text("kind", { enum: knowledgeSourceKinds }).notNull(),
    title: text("title").notNull(),
    /** The page to fetch, for `url` sources. Always fetched through the SSRF-safe fetch. */
    url: text("url"),
    /** The document itself, for `markdown` sources. */
    content: text("content"),
    /** Internal by default: nothing becomes customer-facing without someone choosing it. */
    visibility: text("visibility", { enum: knowledgeVisibilities }).notNull().default("internal"),
    status: text("status", { enum: knowledgeSourceStatuses }).notNull().default("pending"),
    /** Why ingestion failed, as a short code such as `blocked_address`. Never page content. */
    error: text("error"),
    chunkCount: integer("chunk_count").notNull().default(0),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }),
    /** The embedding model of its current chunks. Another model's search skips them. */
    embeddingModel: text("embedding_model"),
    ...gitManageable(),
  },
  (t) => [
    unique("knowledge_sources_tenant_id_id").on(t.tenantId, t.id),
    // Per tenant, so A can't learn from an error that B uses a slug.
    unique("knowledge_sources_tenant_slug").on(t.tenantId, t.slug),
    check("knowledge_sources_kind", sql`${t.kind} in ('url', 'markdown')`),
    check("knowledge_sources_status", sql`${t.status} in ('pending', 'ready', 'failed')`),
    check("knowledge_sources_visibility", sql`${t.visibility} in ('public', 'internal')`),
    check("knowledge_sources_managed_by", sql`${t.managedBy} in ('app', 'git')`),
    check("knowledge_sources_git_path", sql`${t.managedBy} = 'app' or ${t.sourcePath} is not null`),
    check("knowledge_sources_url", sql`${t.kind} <> 'url' or ${t.url} is not null`),
    check("knowledge_sources_content", sql`${t.kind} <> 'markdown' or ${t.content} is not null`),
    tenantIsolation(),
  ],
);

/** Must match the embedding model's output (`embeddingDimensions` in @helpos/ai). */
export const knowledgeEmbeddingDimensions = 1024;

/** A passage of a knowledge source with its embedding. Replaced whenever the source is ingested. */
export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    ...tenantColumns(),
    sourceId: uuid("source_id").notNull(),
    /** Order within the source, from 0. */
    position: integer("position").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: knowledgeEmbeddingDimensions }).notNull(),
    /**
     * The model that made `embedding`. Vectors from different models aren't comparable, so
     * search only ever matches chunks from the model it embedded the query with.
     */
    embeddingModel: text("embedding_model").notNull(),
  },
  (t) => [
    unique("knowledge_chunks_tenant_id_id").on(t.tenantId, t.id),
    foreignKey({
      name: "knowledge_chunks_source_fk",
      columns: [t.tenantId, t.sourceId],
      foreignColumns: [knowledgeSources.tenantId, knowledgeSources.id],
    }).onDelete("cascade"),
    index("knowledge_chunks_tenant_source").on(t.tenantId, t.sourceId),
    // One index for all tenants. It ignores RLS while it searches, so every query also filters
    // on tenant_id and scans iteratively (see searchKnowledge()).
    index("knowledge_chunks_embedding").using("hnsw", t.embedding.op("vector_cosine_ops")),
    tenantIsolation(),
  ],
);

/**
 * The knowledge passages a draft was written with, so the approver sees its sources. `cited`
 * marks the ones the model says it used; the rest were offered but not used.
 *
 * A copy of each passage as the draft saw it, not a pointer to the chunk: re-ingesting replaces
 * a source's chunks, and a sent reply's record of what it was written from must survive that.
 */
export const draftCitations = pgTable(
  "draft_citations",
  {
    ...tenantColumns(),
    draftId: uuid("draft_id").notNull(),
    /**
     * Null once the source is deleted; the copy below stays. Its foreign key is in the
     * migration by hand: it nulls only this column (drizzle-kit can't emit that).
     */
    sourceId: uuid("source_id"),
    title: text("title").notNull(),
    url: text("url"),
    visibility: text("visibility", { enum: knowledgeVisibilities }).notNull(),
    /** The passage text the model was given. */
    excerpt: text("excerpt").notNull(),
    /** Retrieval rank, from 0 (best match). */
    rank: integer("rank").notNull(),
    cited: boolean("cited").notNull(),
  },
  (t) => [
    unique("draft_citations_tenant_draft_rank").on(t.tenantId, t.draftId, t.rank),
    // Deleting a source finds its citations through this, instead of scanning them all.
    index("draft_citations_source").on(t.tenantId, t.sourceId),
    foreignKey({
      name: "draft_citations_draft_fk",
      columns: [t.tenantId, t.draftId],
      foreignColumns: [drafts.tenantId, drafts.id],
    }),
    check("draft_citations_visibility", sql`${t.visibility} in ('public', 'internal')`),
    tenantIsolation(),
  ],
);
