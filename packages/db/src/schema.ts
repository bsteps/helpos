import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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
export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /**
     * On by default: every reply goes to `shadowRecipient` instead of the customer, so no real
     * customer gets mail before the release safety work ships. Turning it off is audited.
     */
    shadowMode: boolean("shadow_mode").notNull().default(true),
    /** Where replies go in shadow mode, usually the workspace owner. Null: replies wait. */
    shadowRecipient: text("shadow_recipient"),
    /**
     * AI tokens this workspace may use per UTC day, set by an operator (never through the API,
     * so a stolen workspace token can't raise its own cap). Null: the server-wide ceiling.
     * The ceiling (HELPOS_AI_DAILY_TOKEN_BUDGET) always wins when it is lower.
     */
    aiDailyTokenBudget: integer("ai_daily_token_budget"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check(
      "tenants_shadow_recipient_lowercase",
      sql`${t.shadowRecipient} = lower(${t.shadowRecipient})`,
    ),
    check("tenants_ai_daily_token_budget_nonnegative", sql`${t.aiDailyTokenBudget} >= 0`),
  ],
);

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

function enumCheck(name: string, column: AnyPgColumn, values: readonly [string, ...string[]]) {
  const literals = sql.join(
    values.map((value) => sql.raw(`'${value.replaceAll("'", "''")}'`)),
    sql`, `,
  );
  return check(name, sql`${column} in (${literals})`);
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
    /** Better Auth's field. Always false until email verification exists (#11). */
    emailVerified: boolean("email_verified").notNull().default(false),
    /** Better Auth's field. Unused. */
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [isLowercase("users_email_lowercase", sql`${t.email}`)],
);

/** A signed-in browser. Better Auth writes these; the cookie holds a signed copy of `token`. */
export const sessions = authSchema.table(
  "sessions",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("sessions_user").on(t.userId)],
);

/**
 * How a user signs in. Only `credential` (email + password) exists: `accountId` is the user's
 * ID and `password` is the hash. The other columns are Better Auth's, for providers we don't use.
 */
export const accounts = authSchema.table(
  "accounts",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    password: text("password"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [unique("accounts_provider_account").on(t.providerId, t.accountId)],
);

/**
 * Short-lived one-time values. Password-setup links store only the SHA-256 of their token in
 * `identifier`, so a database read can't be turned into a working link.
 */
export const verifications = authSchema.table(
  "verifications",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("verifications_identifier").on(t.identifier)],
);

// --- Tenant tables ----------------------------------------------------------------------------

export const workspaceRoles = ["owner", "member"] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];

/** Which workspaces a user belongs to. */
export const memberships = pgTable(
  "memberships",
  {
    ...tenantColumns(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role", { enum: workspaceRoles }).notNull(),
  },
  (t) => [
    unique("memberships_tenant_user").on(t.tenantId, t.userId),
    enumCheck("memberships_role", t.role, workspaceRoles),
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

export const conversationStatuses = ["open", "closed"] as const;

export const aiPausedReasons = ["daily_budget", "draft_failed"] as const;
export type AiPausedReason = (typeof aiPausedReasons)[number];

/** A conversation with a customer. */
export const conversations = pgTable(
  "conversations",
  {
    ...tenantColumns(),
    customerId: uuid("customer_id").notNull(),
    mailboxId: uuid("mailbox_id").notNull(),
    subject: text("subject").notNull(),
    status: text("status", { enum: conversationStatuses }).notNull().default("open"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    /** Opened by machine-sent mail (out-of-office, bounce, list). Never gets an AI draft. */
    automated: boolean("automated").notNull().default(false),
    /**
     * Why the conversation has no AI draft: `daily_budget` (the budget was spent) or `draft_failed`
     * (every attempt failed). Cleared when a draft is made.
     */
    aiPausedReason: text("ai_paused_reason", { enum: aiPausedReasons }),
  },
  (t) => [
    unique("conversations_tenant_id_id").on(t.tenantId, t.id),
    enumCheck("conversations_status", t.status, conversationStatuses),
    enumCheck("conversations_ai_paused_reason", t.aiPausedReason, aiPausedReasons),
    // Composite keys: a row can never point at another tenant's row, even if RLS were off.
    foreignKey({
      name: "conversations_customer_fk",
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: "conversations_mailbox_fk",
      columns: [t.tenantId, t.mailboxId],
      foreignColumns: [mailboxes.tenantId, mailboxes.id],
    }),
    index("conversations_tenant_last_message").on(t.tenantId, t.lastMessageAt),
    // The inbox: open conversations, newest activity first.
    index("conversations_tenant_status_last_message").on(t.tenantId, t.status, t.lastMessageAt),
    tenantIsolation(),
  ],
);

export const messageDirections = ["inbound", "outbound"] as const;

/** An email on a conversation. Bodies are stored as received: data, never instructions (ADR 0004). */
export const messages = pgTable(
  "messages",
  {
    ...tenantColumns(),
    conversationId: uuid("conversation_id").notNull(),
    direction: text("direction", { enum: messageDirections }).notNull(),
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
    enumCheck("messages_direction", t.direction, messageDirections),
    foreignKey({
      name: "messages_conversation_fk",
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }),
    index("messages_tenant_conversation").on(t.tenantId, t.conversationId),
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

export const draftStatuses = ["pending", "approved", "sent", "send_failed", "discarded"] as const;
export type DraftStatus = (typeof draftStatuses)[number];
/**
 * `reply` answers the customer's message. `fixed` tells them the GitHub issue made from their
 * conversation was closed as done. Both go through the same approval and the same send worker.
 */
export const draftKinds = ["reply", "fixed"] as const;
export type DraftKind = (typeof draftKinds)[number];

/**
 * An AI-written reply to one inbound message: `pending → approved → sent`, or `discarded`.
 * Written only by apps/server/src/drafts/lifecycle.ts, whose table lists every allowed status
 * change. Only approval moves it to `approved`, and only the send worker sends it. When
 * every send attempt fails it becomes `send_failed`: retried (back to `approved`, same
 * Message-ID) or discarded by a person or agent, never left stuck.
 */
export const drafts = pgTable(
  "drafts",
  {
    ...tenantColumns(),
    conversationId: uuid("conversation_id").notNull(),
    /**
     * The inbound message this replies to. At most one live (not discarded) draft of each kind
     * per message, so a job retry or a repeated webhook can't add a second one.
     */
    messageId: uuid("message_id").notNull(),
    body: text("body").notNull(),
    kind: text("kind", { enum: draftKinds }).notNull().default("reply"),
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
    // One live draft of each kind per message. A "fixed" notice already sent doesn't count: if
    // the issue is reopened and closed again, the fix that holds this time gets a notice too.
    uniqueIndex("drafts_tenant_message_kind_live")
      .on(t.tenantId, t.messageId, t.kind)
      .where(sql`status <> 'discarded' and not (kind = 'fixed' and status = 'sent')`),
    enumCheck("drafts_status", t.status, draftStatuses),
    enumCheck("drafts_kind", t.kind, draftKinds),
    foreignKey({
      name: "drafts_conversation_fk",
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
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
    index("drafts_tenant_conversation").on(t.tenantId, t.conversationId),
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
    enumCheck("audit_events_actor_type", t.actorType, actorTypes),
    index("audit_events_tenant_target").on(t.tenantId, t.targetType, t.targetId),
    tenantIsolation(),
  ],
);

/**
 * What an agent token may be granted, and the one list of scopes the API checks (the server adds
 * only `workspace:admin`). A new scope is one line here plus a generated migration (the CHECK
 * below follows this list; `schema.test.ts` fails if the migration is missing).
 *
 * `conversations:write` changes a conversation itself (closing it, #46). `drafts:approve` is separate so an
 * agent can draft without sending. `knowledge:write` is separate from reading, because what's in
 * the knowledge base shapes every draft. `github:write` drafts and opens GitHub issues from
 * conversations (#37); connecting the repo and its token is `workspace:admin`. `stats:read` reads
 * workspace numbers such as how many drafts are approved unchanged (#116).
 *
 * Workspace administration (`workspace:admin`: shadow mode, minting tokens) is deliberately
 * missing: that stays with humans signed in to a session.
 */
export const apiTokenScopes = [
  "conversations:read",
  "conversations:write",
  "drafts:write",
  "drafts:approve",
  "knowledge:read",
  "knowledge:write",
  "github:write",
  "stats:read",
] as const;
export type ApiTokenScope = (typeof apiTokenScopes)[number];

/**
 * An agent's API token (`hos_…`). Only the SHA-256 of the token is stored; the token itself is
 * shown once, when it is created. One token is one agent identity: audit events name its ID.
 * Revoked, not deleted, so the audit log never points at a token that no longer exists. The app
 * role can change nothing but `revoked_at` (migration 0012).
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    ...tenantColumns(),
    /** The agent's name, e.g. `triage-bot`. Shown in lists and next to its audit events. */
    name: text("name").notNull(),
    /**
     * Hex SHA-256 of the whole token. Globally unique, but it's a hash of 32 random bytes that
     * we generate, so a clash says nothing about another workspace (ADR 0009 §7).
     */
    tokenHash: text("token_hash").notNull().unique("api_tokens_token_hash"),
    scopes: text("scopes", { enum: apiTokenScopes }).array().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    unique("api_tokens_tenant_id_id").on(t.tenantId, t.id),
    check("api_tokens_token_hash_format", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "api_tokens_scopes",
      sql`cardinality(${t.scopes}) > 0 and ${t.scopes} <@ array[${sql.raw(
        apiTokenScopes.map((s) => `'${s}'`).join(", "),
      )}]::text[]`,
    ),
    tenantIsolation(),
    // A request names its token before anyone knows the workspace. This read-only policy shows
    // exactly one row: the one whose hash the caller already has (like `route_by_address`).
    pgPolicy("resolve_by_token_hash", {
      for: "select",
      using: sql`token_hash = nullif(current_setting('app.token_hash', true), '')`,
    }),
  ],
);

/**
 * AI tokens a workspace used on one UTC day, summed from the model's responses. The daily
 * budget is checked against this before every model call. Written only by
 * apps/server/src/ai-budget/budget.ts.
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
    /**
     * Held for calls in flight: each one's upper-bound estimate, until it settles to what it
     * really cost. Kept apart from the tokens above, so usage shows only what was spent.
     */
    reservedTokens: bigint("reserved_tokens", { mode: "number" }).notNull().default(0),
    /**
     * When the newest reservation runs out. Past it, `reservedTokens` counts as 0: a call
     * that never settled (a crash, a deploy mid-call) holds the budget for minutes, not all day.
     */
    reservedUntil: timestamp("reserved_until", { withTimezone: true }),
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
    /**
     * Counts requests to ingest it again. An ingest job writes its result only if no newer
     * request came in while it was fetching, so a page change asked for meanwhile isn't lost.
     */
    ingestRequests: integer("ingest_requests").notNull().default(0),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }),
    /** The embedding model of its current chunks. Another model's search skips them. */
    embeddingModel: text("embedding_model"),
    ...gitManageable(),
  },
  (t) => [
    unique("knowledge_sources_tenant_id_id").on(t.tenantId, t.id),
    // Per tenant, so A can't learn from an error that B uses a slug.
    unique("knowledge_sources_tenant_slug").on(t.tenantId, t.slug),
    // One source per page, so drafts don't see the same passages twice. Per tenant too, and
    // `url` is stored normalised (normalizeKnowledgeUrl()) so case or a fragment don't slip by.
    uniqueIndex("knowledge_sources_tenant_url").on(t.tenantId, t.url).where(sql`${t.kind} = 'url'`),
    enumCheck("knowledge_sources_kind", t.kind, knowledgeSourceKinds),
    enumCheck("knowledge_sources_status", t.status, knowledgeSourceStatuses),
    enumCheck("knowledge_sources_visibility", t.visibility, knowledgeVisibilities),
    enumCheck("knowledge_sources_managed_by", t.managedBy, managedByValues),
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
    enumCheck("draft_citations_visibility", t.visibility, knowledgeVisibilities),
    tenantIsolation(),
  ],
);

// --- Integrations ----------------------------------------------------------------------------

export const integrationProviders = ["github"] as const;
export type IntegrationProvider = (typeof integrationProviders)[number];

/**
 * A workspace's link to an outside service. For `github`: one repo and a fine-grained personal
 * access token. The token and the webhook secret are stored only encrypted (AES-256-GCM with
 * HELPOS_ENCRYPTION_KEY, bound to this workspace), never in plain text, and the API never
 * returns them.
 */
export const integrations = pgTable(
  "integrations",
  {
    ...tenantColumns(),
    provider: text("provider", { enum: integrationProviders }).notNull(),
    /** `owner/name`, lowercase: GitHub treats repo names case-insensitively. */
    repo: text("repo").notNull(),
    tokenCiphertext: text("token_ciphertext").notNull(),
    /** Signs the webhooks GitHub sends us (`X-Hub-Signature-256`). Generated by us. */
    webhookSecretCiphertext: text("webhook_secret_ciphertext").notNull(),
  },
  (t) => [
    // One repo per workspace for now.
    unique("integrations_tenant_provider").on(t.tenantId, t.provider),
    enumCheck("integrations_provider", t.provider, integrationProviders),
    isLowercase("integrations_repo_lowercase", sql`${t.repo}`),
    tenantIsolation(),
  ],
);

export const githubIssueStates = ["creating", "open", "closed"] as const;
export type GithubIssueState = (typeof githubIssueStates)[number];

/**
 * The GitHub issue made from a conversation. `creating` holds the conversation's place while GitHub is
 * called, so a double click can't open two issues; the call runs with no transaction open.
 */
export const conversationGithubIssues = pgTable(
  "conversation_github_issues",
  {
    ...tenantColumns(),
    conversationId: uuid("conversation_id").notNull(),
    /** The repo the issue is in, lowercase `owner/name`. Kept if the workspace changes repo. */
    repo: text("repo").notNull(),
    issueNumber: integer("issue_number"),
    issueUrl: text("issue_url"),
    state: text("state", { enum: githubIssueStates }).notNull().default("creating"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /**
     * GitHub's own time (the issue's `updated_at`) of the last close or reopen applied. An
     * event older than it is stale (a late retry, a redelivery) and changes nothing.
     */
    stateChangedAt: timestamp("state_changed_at", { withTimezone: true }),
  },
  (t) => [
    // One issue per conversation.
    unique("conversation_github_issues_tenant_conversation").on(t.tenantId, t.conversationId),
    foreignKey({
      name: "conversation_github_issues_conversation_fk",
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }),
    // The webhook finds conversations by the closed issue. Unique: an issue is made from one conversation,
    // so its "fixed" notice can only ever go to that conversation's customer. (A claim has no number
    // yet, and nulls never clash.)
    uniqueIndex("conversation_github_issues_tenant_issue").on(t.tenantId, t.repo, t.issueNumber),
    enumCheck("conversation_github_issues_state", t.state, githubIssueStates),
    check(
      "conversation_github_issues_created",
      sql`${t.state} = 'creating' or (${t.issueNumber} is not null and ${t.issueUrl} is not null)`,
    ),
    isLowercase("conversation_github_issues_repo_lowercase", sql`${t.repo}`),
    tenantIsolation(),
  ],
);
