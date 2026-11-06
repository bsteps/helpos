import { type SQL, sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgPolicy,
  pgSchema,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
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
  },
  (t) => [
    unique("tickets_tenant_id_id").on(t.tenantId, t.id),
    check("tickets_status", sql`${t.status} in ('open', 'closed')`),
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
