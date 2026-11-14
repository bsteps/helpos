import { createHash } from "node:crypto";
import type { schema } from "@helpos/db";
import { hashBody } from "../audit/details.ts";

// Demo data for local dev, e2e tests and agent QA. Pure: no I/O, and the same output every time,
// so tests and screenshots can rely on exact IDs, tokens and timestamps. Every company, person
// and address is made up; emails use the reserved `.test` domain, so nothing can ever be mailed.

/** Changing this changes every ID, token and timestamp jitter below. */
const seed = "helpos-demo-v1";
/** All timestamps count from here, so they don't depend on when the seed runs. */
const baseTime = Date.UTC(2026, 0, 12, 8, 0, 0);

/** mulberry32: a tiny PRNG, good enough for jitter and stable across Node versions. */
function prng(key: string): () => number {
  let a = createHash("sha256").update(`${seed}:${key}`).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A UUIDv7-shaped ID from a name: the timestamp is the row's own, the rest comes from a hash of
 * the name. Derived per name rather than drawn in sequence, so adding a conversation later doesn't
 * change the IDs of all the others.
 */
function seedId(name: string, at: Date): string {
  const bytes = createHash("sha256").update(`${seed}:id:${name}`).digest().subarray(0, 16);
  let ts = at.getTime();
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A fixed `hos_` token, so e2e tests and agents can use it without reading it back from the
 * database. It is public (it is in this repo), which is why the seed refuses production.
 * `.claude/skills/verify-helpos/scripts/instance.mjs` imports it at runtime, out of knip's sight.
 *
 * @public
 */
export function seedToken(name: string): string {
  return `hos_${createHash("sha256").update(`${seed}:token:${name}`).digest("base64url")}`;
}

// --- What the scenarios are written in -------------------------------------------------------

type Msg = { from: "customer" | "team"; text: string; minutes: number };
type DraftSpec = {
  // No "approved": a real approval also fixes the Message-ID and queues the send, which a seed
  // row would lack, so it would be stuck. Approve a pending one through the API instead.
  status: "pending" | "sent" | "discarded";
  text: string;
  /** Knowledge sources offered to the draft, by slug, best match first. */
  sources: { slug: string; cited: boolean }[];
  /**
   * Agent tokens, by name, that edited the draft before it was approved: one `draft.edited`
   * audit event each. `text` is the body after the edits.
   */
  editedBy?: string[];
};
type ConversationSpec = {
  key: string;
  customer: string;
  subject: string;
  /** Hours after `baseTime` the first message arrived. */
  hours: number;
  messages: Msg[];
  status?: "open" | "closed";
  /** Opened by an auto-reply, so it never gets a draft. */
  automatedReason?: string;
  aiPaused?: boolean;
  /** Replies to the last customer message. */
  draft?: DraftSpec;
};
type SourceSpec = {
  slug: string;
  title: string;
  visibility: "public" | "internal";
  content: string;
};
type TenantSpec = {
  key: string;
  name: string;
  domain: string;
  mailbox: string;
  members: { email: string; name: string; role: schema.WorkspaceRole }[];
  customers: { email: string; name: string }[];
  tokens: { name: string; scopes: schema.ApiTokenScope[]; revoked?: boolean }[];
  sources: SourceSpec[];
  conversations: ConversationSpec[];
};

const tenantSpecs: TenantSpec[] = [
  {
    key: "northwind",
    name: "Northwind Cycles",
    domain: "northwind-cycles.test",
    mailbox: "support@northwind-cycles.test",
    members: [
      { email: "maya.okafor@northwind-cycles.test", name: "Maya Okafor", role: "owner" },
      { email: "leo.brandt@northwind-cycles.test", name: "Leo Brandt", role: "member" },
    ],
    customers: [
      { email: "sam.rivera@example.test", name: "Sam Rivera" },
      { email: "priya.n@example.test", name: "Priya Natarajan" },
      { email: "jonas.weber@example.test", name: "Jonas Weber" },
      { email: "chloe.martin@example.test", name: "Chloé Martin" },
      { email: "ahmed.k@example.test", name: "Ahmed Karimi" },
    ],
    tokens: [
      { name: "triage-bot", scopes: ["conversations:read", "drafts:write", "knowledge:read"] },
      { name: "approver-bot", scopes: ["conversations:read", "drafts:approve"] },
      { name: "old-import-script", scopes: ["knowledge:write"], revoked: true },
    ],
    sources: [
      {
        slug: "shipping/delivery-times",
        title: "Delivery times",
        visibility: "public",
        content:
          "# Delivery times\n\nOrders ship from our warehouse within 2 working days. Standard delivery takes 3–5 working days in the EU and 7–10 elsewhere. Every order gets a tracking link by email when it ships.\n\nBikes ship in a large box and need a signature on delivery.",
      },
      {
        slug: "returns/policy",
        title: "Returns and refunds",
        visibility: "public",
        content:
          "# Returns and refunds\n\nYou can return unused items within 30 days of delivery. Start a return from your order page; we email a prepaid label. Refunds go back to the original payment method within 5 working days of the return reaching us.\n\nBikes that have been ridden can't be returned, but are covered by the warranty.",
      },
      {
        slug: "warranty/frames",
        title: "Frame warranty",
        visibility: "public",
        content:
          "# Frame warranty\n\nFrames have a 5-year warranty against manufacturing defects. Send photos of the damage and your order number. Crash damage isn't covered, but owners get 30% off a replacement frame.",
      },
      {
        slug: "internal/refund-exceptions",
        title: "Refund exceptions (internal)",
        visibility: "internal",
        content:
          "# Refund exceptions\n\nTeam leads may approve a refund up to 45 days after delivery for loyal customers (3+ orders). Never promise this to a customer before a lead approves it.",
      },
    ],
    conversations: [
      {
        key: "where-is-order",
        customer: "sam.rivera@example.test",
        subject: "Where is my order #NW-10482?",
        hours: 2,
        messages: [
          {
            from: "customer",
            minutes: 0,
            text: "Hi, I ordered a helmet and lights last Monday (order #NW-10482) and haven't had a tracking email yet. Has it shipped?\n\nThanks,\nSam",
          },
        ],
        draft: {
          status: "pending",
          text: "Hi Sam,\n\nThanks for getting in touch. Orders leave our warehouse within 2 working days, and you'll get a tracking link by email as soon as yours ships. I've asked the warehouse to check on #NW-10482 and will reply here with the tracking link today.\n\nBest,\nNorthwind Cycles",
          sources: [
            { slug: "shipping/delivery-times", cited: true },
            { slug: "returns/policy", cited: false },
          ],
        },
      },
      {
        key: "return-shoes",
        customer: "priya.n@example.test",
        subject: "Return cycling shoes, wrong size",
        hours: 5,
        messages: [
          {
            from: "customer",
            minutes: 0,
            text: "Hello! The shoes I got are a size too small. They're unworn and still in the box. How do I send them back?",
          },
        ],
        draft: {
          status: "pending",
          text: "Hi Priya,\n\nSorry they don't fit! You can return unused items within 30 days: start a return from your order page and we'll email you a prepaid label. Your refund goes back to your original payment method within 5 working days of the return reaching us.\n\nBest,\nNorthwind Cycles",
          sources: [{ slug: "returns/policy", cited: true }],
        },
      },
      {
        key: "cracked-frame",
        customer: "jonas.weber@example.test",
        subject: "Crack near the bottom bracket",
        hours: 26,
        messages: [
          {
            from: "customer",
            minutes: 0,
            text: "I found a hairline crack near the bottom bracket of my Trail 3 frame, bought 2 years ago. I haven't crashed it. Is this covered?",
          },
          {
            from: "team",
            minutes: 95,
            text: "Hi Jonas,\n\nThat sounds like it could be a manufacturing defect, which our 5-year frame warranty covers. Could you send a few photos of the crack and your order number?\n\nBest,\nNorthwind Cycles",
          },
          {
            from: "customer",
            minutes: 240,
            text: "Photos attached in my next mail, order number is #NW-07731.",
          },
        ],
        draft: {
          status: "pending",
          text: "Hi Jonas,\n\nThanks, we've got your order number. As soon as the photos arrive, our workshop team will review them and confirm the warranty replacement.\n\nBest,\nNorthwind Cycles",
          sources: [
            { slug: "warranty/frames", cited: true },
            { slug: "returns/policy", cited: false },
          ],
        },
      },
      {
        key: "late-refund",
        customer: "chloe.martin@example.test",
        subject: "Refund after 40 days?",
        hours: 30,
        messages: [
          {
            from: "customer",
            minutes: 0,
            text: "I know it's been about 40 days, but the saddle bag never fit my bike. I've ordered from you four times before. Any chance of a refund?",
          },
        ],
        draft: {
          status: "discarded",
          text: "Hi Chloé,\n\nSure, we can refund you even after 40 days since you're a loyal customer.",
          sources: [
            { slug: "internal/refund-exceptions", cited: true },
            { slug: "returns/policy", cited: true },
          ],
        },
      },
      {
        key: "delivery-question",
        customer: "ahmed.k@example.test",
        subject: "Shipping to Norway?",
        hours: 50,
        status: "closed",
        messages: [
          {
            from: "customer",
            minutes: 0,
            text: "Do you ship complete bikes to Norway, and how long does it take?",
          },
          {
            from: "team",
            minutes: 30,
            text: "Hi Ahmed,\n\nYes, we do. Delivery outside the EU takes 7–10 working days, and bikes need a signature on delivery.\n\nBest,\nNorthwind Cycles",
          },
        ],
        draft: {
          status: "sent",
          text: "Hi Ahmed,\n\nYes, we do. Delivery outside the EU takes 7–10 working days, and bikes need a signature on delivery.\n\nBest,\nNorthwind Cycles",
          sources: [{ slug: "shipping/delivery-times", cited: true }],
        },
      },
      {
        key: "bell-mount",
        customer: "jonas.weber@example.test",
        subject: "Does the bell fit drop bars?",
        hours: 54,
        status: "closed",
        messages: [
          {
            from: "customer",
            minutes: 0,
            text: "Will the brass bell from your shop fit on drop handlebars?",
          },
          {
            from: "team",
            minutes: 25,
            text: "Hi Jonas,\n\nYes: the clamp fits bars from 22.2 to 31.8 mm, which covers drop bars.\n\nBest,\nNorthwind Cycles",
          },
        ],
        draft: {
          status: "sent",
          text: "Hi Jonas,\n\nYes: the clamp fits bars from 22.2 to 31.8 mm, which covers drop bars.\n\nBest,\nNorthwind Cycles",
          sources: [],
        },
      },
      {
        key: "tracking-link",
        customer: "chloe.martin@example.test",
        subject: "Tracking link doesn't work",
        hours: 58,
        status: "closed",
        messages: [
          {
            from: "customer",
            minutes: 0,
            text: "The tracking link in my shipping email shows a blank page.",
          },
          {
            from: "team",
            minutes: 40,
            text: "Hi Chloé,\n\nSorry about that. The carrier's page was down this morning; the link works again now. Your order is due on Thursday.\n\nBest,\nNorthwind Cycles",
          },
        ],
        draft: {
          status: "sent",
          text: "Hi Chloé,\n\nSorry about that. The carrier's page was down this morning; the link works again now. Your order is due on Thursday.\n\nBest,\nNorthwind Cycles",
          sources: [{ slug: "shipping/delivery-times", cited: false }],
          editedBy: ["triage-bot", "triage-bot"],
        },
      },
      {
        key: "out-of-office",
        customer: "sam.rivera@example.test",
        subject: "Automatic reply: Your order has shipped",
        hours: 52,
        automatedReason: "auto-submitted",
        messages: [
          {
            from: "customer",
            minutes: 0,
            text: "I'm out of the office until Monday with limited access to email.",
          },
        ],
      },
      {
        key: "budget-paused",
        customer: "priya.n@example.test",
        subject: "Gift card not working",
        hours: 70,
        aiPaused: true,
        messages: [
          {
            from: "customer",
            minutes: 0,
            text: "The gift card code GC-4471 says it's invalid at checkout. It was a birthday present.",
          },
        ],
      },
    ],
  },
  {
    key: "lumen",
    name: "Lumen Analytics",
    domain: "lumen-analytics.test",
    mailbox: "help@lumen-analytics.test",
    members: [
      { email: "ines.duarte@lumen-analytics.test", name: "Inês Duarte", role: "owner" },
      { email: "tom.havel@lumen-analytics.test", name: "Tom Havel", role: "member" },
      { email: "grace.liu@lumen-analytics.test", name: "Grace Liu", role: "member" },
    ],
    customers: [
      { email: "ops@brightpath.test", name: "Dana Fischer" },
      { email: "billing@corvid-labs.test", name: "Marcus Bell" },
      { email: "kenji@tidewater.test", name: "Kenji Sato" },
      { email: "ana.lopez@meridian.test", name: "Ana López" },
    ],
    tokens: [
      {
        name: "support-agent",
        scopes: ["conversations:read", "drafts:write", "drafts:approve", "knowledge:read"],
      },
      { name: "docs-sync", scopes: ["knowledge:read", "knowledge:write"] },
    ],
    sources: [
      {
        slug: "billing/plans",
        title: "Plans and billing",
        visibility: "public",
        content:
          "# Plans and billing\n\nPlans are billed monthly or yearly per seat. Adding a seat is charged pro rata; removing one takes effect at the next renewal. Invoices are emailed to the billing contact and are available under Settings → Billing.",
      },
      {
        slug: "integrations/csv-import",
        title: "Importing CSV files",
        visibility: "public",
        content:
          "# Importing CSV files\n\nCSV imports accept UTF-8 files up to 200 MB with a header row. Dates must be ISO 8601 (YYYY-MM-DD). A file with a byte-order mark or semicolon separators is rejected with the error `unsupported_format`.",
      },
      {
        slug: "security/sso",
        title: "Single sign-on",
        visibility: "public",
        content:
          "# Single sign-on\n\nSAML SSO is available on the Business plan. Set it up under Settings → Security. Once enforced, password sign-in is turned off for everyone except workspace owners.",
      },
      {
        slug: "internal/known-issues",
        title: "Known issues (internal)",
        visibility: "internal",
        content:
          "# Known issues\n\nDashboards with more than 40 charts may time out on first load since release 4.12. Workaround: split the dashboard. Fix planned for 4.14.",
      },
    ],
    conversations: [
      {
        key: "csv-import-error",
        customer: "kenji@tidewater.test",
        subject: "CSV import fails with unsupported_format",
        hours: 3,
        messages: [
          {
            from: "customer",
            minutes: 0,
            text: "Every CSV export from our ERP fails to import with `unsupported_format`. The files open fine in Excel. What are we doing wrong?",
          },
        ],
        draft: {
          status: "pending",
          text: "Hi Kenji,\n\nThat error usually means the file uses semicolons as separators or starts with a byte-order mark. Could you re-export it as UTF-8 without a BOM, with commas as separators? Dates also need to be in YYYY-MM-DD format.\n\nBest,\nLumen Analytics",
          sources: [
            { slug: "integrations/csv-import", cited: true },
            { slug: "billing/plans", cited: false },
          ],
        },
      },
      {
        key: "seat-billing",
        customer: "billing@corvid-labs.test",
        subject: "Charged for seats we removed",
        hours: 8,
        messages: [
          {
            from: "customer",
            minutes: 0,
            text: "We removed three seats on the 3rd but this month's invoice still bills for them. Can you correct it?",
          },
        ],
        draft: {
          status: "pending",
          text: "Hi Marcus,\n\nRemoving a seat takes effect at your next renewal, so this invoice still includes the three seats. From your next invoice on, they won't be billed. You can see every invoice under Settings → Billing.\n\nBest,\nLumen Analytics",
          sources: [{ slug: "billing/plans", cited: true }],
        },
      },
      {
        key: "slow-dashboard",
        customer: "ops@brightpath.test",
        subject: "Main dashboard times out",
        hours: 27,
        messages: [
          {
            from: "customer",
            minutes: 0,
            text: "Since last week our main KPI dashboard won't load at all, it just spins and times out. It has about 55 charts.",
          },
          {
            from: "team",
            minutes: 60,
            text: "Hi Dana,\n\nThanks for the report, we're looking into it and will get back to you shortly.\n\nBest,\nLumen Analytics",
          },
          {
            from: "customer",
            minutes: 1440,
            text: "Any update? Our weekly review is tomorrow morning.",
          },
        ],
        draft: {
          status: "pending",
          text: "Hi Dana,\n\nSorry for the wait. Very large dashboards can currently time out on first load; a fix is planned for an upcoming release. Until then, splitting the dashboard into two smaller ones will get it loading again in time for your review.\n\nBest,\nLumen Analytics",
          sources: [
            { slug: "internal/known-issues", cited: true },
            { slug: "integrations/csv-import", cited: false },
          ],
        },
      },
      {
        key: "sso-question",
        customer: "ana.lopez@meridian.test",
        subject: "Can owners still sign in with a password after SSO?",
        hours: 48,
        status: "closed",
        messages: [
          {
            from: "customer",
            minutes: 0,
            text: "If we enforce SAML SSO, will our owners be locked out if the identity provider goes down?",
          },
          {
            from: "team",
            minutes: 45,
            text: "Hi Ana,\n\nNo: workspace owners can always sign in with a password, even when SSO is enforced, so you keep a way in if your identity provider is down.\n\nBest,\nLumen Analytics",
          },
        ],
        draft: {
          status: "sent",
          text: "Hi Ana,\n\nNo: workspace owners can always sign in with a password, even when SSO is enforced, so you keep a way in if your identity provider is down.\n\nBest,\nLumen Analytics",
          sources: [{ slug: "security/sso", cited: true }],
        },
      },
      {
        key: "bounce",
        customer: "kenji@tidewater.test",
        subject: "Undeliverable: Your weekly report",
        hours: 49,
        automatedReason: "bounce",
        messages: [
          {
            from: "customer",
            minutes: 0,
            text: "Delivery has failed to these recipients or groups: reports@tidewater.test",
          },
        ],
      },
    ],
  },
];

// --- The rows, built from the scenarios ------------------------------------------------------

type DemoUser = { email: string; name: string };
export type DemoData = ReturnType<typeof buildDemoData>;

/** Builds every row the seed writes. Same input, same output: there is no input. */
export function buildDemoData() {
  const users: DemoUser[] = [];
  const tenants = tenantSpecs.map((spec) => {
    const jitter = prng(spec.key);
    const at = (minutes: number) =>
      // Up to 59 seconds of jitter, so rows aren't all on round minutes.
      new Date(baseTime + minutes * 60_000 + Math.floor(jitter() * 59) * 1000);
    const created = new Date(baseTime - 30 * 24 * 60 * 60_000);
    const id = (name: string, when: Date = created) => seedId(`${spec.key}:${name}`, when);
    const tenantId = id("tenant");
    const owner = spec.members.find((m) => m.role === "owner");
    if (!owner) throw new Error(`demo tenant ${spec.key} has no owner`);
    for (const m of spec.members) users.push({ email: m.email, name: m.name });

    const tenant = {
      id: tenantId,
      name: spec.name,
      shadowMode: true,
      shadowRecipient: owner.email,
      createdAt: created,
      updatedAt: created,
    };
    const stamp = { tenantId, createdAt: created, updatedAt: created };
    const mailbox = { ...stamp, id: id("mailbox"), address: spec.mailbox };
    const memberships = spec.members.map((m) => ({
      ...stamp,
      id: id(`membership:${m.email}`),
      email: m.email,
      role: m.role,
    }));
    const customers = spec.customers.map((c) => ({
      ...stamp,
      id: id(`customer:${c.email}`),
      email: c.email,
      name: c.name,
    }));
    const customerByEmail = new Map(customers.map((c) => [c.email, c]));

    const sources = spec.sources.map((s) => ({
      ...stamp,
      id: id(`source:${s.slug}`),
      slug: s.slug,
      kind: "markdown" as const,
      title: s.title,
      content: s.content,
      visibility: s.visibility,
    }));
    const sourceBySlug = new Map(sources.map((s) => [s.slug, s]));

    const tokens = spec.tokens.map((t) => ({
      ...stamp,
      id: id(`token:${t.name}`),
      name: t.name,
      token: seedToken(`${spec.key}:${t.name}`),
      scopes: [...t.scopes].sort(),
      revokedAt: t.revoked ? at(60) : null,
    }));
    const audit: (typeof schema.auditEvents.$inferInsert & { id: string })[] = tokens.flatMap(
      (t) => {
        const event = (action: "api_token.created" | "api_token.revoked", when: Date) => ({
          id: id(`audit:${action}:${t.name}`, when),
          tenantId,
          createdAt: when,
          actorType: "system" as const,
          actorId: "seed",
          action,
          targetType: "api_token",
          targetId: t.id,
          requestId: null,
          details: {},
        });
        const created = event("api_token.created", t.createdAt);
        return t.revokedAt ? [created, event("api_token.revoked", t.revokedAt)] : [created];
      },
    );

    const conversations: (typeof schema.conversations.$inferInsert & { createdAt: Date })[] = [];
    const messages: (typeof schema.messages.$inferInsert & { id: string; createdAt: Date })[] = [];
    const drafts: (typeof schema.drafts.$inferInsert & { id: string })[] = [];
    const citations: (typeof schema.draftCitations.$inferInsert & { id: string })[] = [];
    for (const ts of spec.conversations) {
      const customer = customerByEmail.get(ts.customer);
      if (!customer)
        throw new Error(`demo conversation ${ts.key}: unknown customer ${ts.customer}`);
      // The conversation opens when its first message arrives, to the second.
      const times = ts.messages.map((m) => at(ts.hours * 60 + m.minutes));
      const opened = times[0];
      if (!opened) throw new Error(`demo conversation ${ts.key} has no messages`);
      // Keep the original seed name so IDs match databases seeded before the rename.
      const conversationId = id(`ticket:${ts.key}`, opened);
      const headers = ts.messages.map(
        (m, i) => `<${ts.key}.${i}@${m.from === "customer" ? "mail.example.test" : spec.domain}>`,
      );
      const conversationMessages = ts.messages.map((m, i) => {
        const sentAt = times[i] ?? opened;
        const inbound = m.from === "customer";
        return {
          id: id(`message:${ts.key}:${i}`, sentAt),
          tenantId,
          conversationId,
          direction: inbound ? ("inbound" as const) : ("outbound" as const),
          fromAddress: inbound ? customer.email : spec.mailbox,
          fromName: inbound ? customer.name : spec.name,
          toAddresses: [inbound ? spec.mailbox : customer.email],
          subject: i === 0 ? ts.subject : `Re: ${ts.subject}`,
          textBody: m.text,
          htmlBody: null,
          messageIdHeader: headers[i] ?? null,
          inReplyTo: headers[i - 1] ?? null,
          references: headers.slice(0, i),
          // Seeded mail was never received, so there is no raw file behind this key.
          rawFileKey: `${tenantId}/seed-${ts.key}-${i}`,
          sentAt: inbound ? null : sentAt,
          automatedReason: inbound && ts.automatedReason ? ts.automatedReason : null,
          createdAt: sentAt,
          updatedAt: sentAt,
        };
      });
      messages.push(...conversationMessages);
      const last = conversationMessages[conversationMessages.length - 1];
      if (!last) throw new Error(`demo conversation ${ts.key} has no messages`);
      conversations.push({
        id: conversationId,
        tenantId,
        customerId: customer.id,
        mailboxId: mailbox.id,
        subject: ts.subject,
        status: ts.status ?? ("open" as const),
        lastMessageAt: last.createdAt,
        automated: ts.automatedReason !== undefined,
        aiPausedReason: ts.aiPaused ? ("daily_budget" as const) : null,
        createdAt: opened,
        updatedAt: last.createdAt,
      });

      if (!ts.draft) continue;
      const d = ts.draft;
      // A sent draft replied to the customer message before the team's reply; any other draft
      // answers the latest customer message.
      const sentReply =
        d.status === "sent"
          ? conversationMessages.findLast((m) => m.direction === "outbound")
          : undefined;
      const repliesTo = conversationMessages.findLast(
        (m) => m.direction === "inbound" && (!sentReply || m.createdAt < sentReply.createdAt),
      );
      if (!repliesTo) throw new Error(`demo conversation ${ts.key}: draft has no inbound message`);
      if (d.status === "sent" && !sentReply) {
        throw new Error(`demo conversation ${ts.key}: sent draft needs an outbound message`);
      }
      const draftedAt = new Date(repliesTo.createdAt.getTime() + 2 * 60_000);
      const approvedAt = d.status === "sent" ? new Date(draftedAt.getTime() + 10 * 60_000) : null;
      const draftId = id(`draft:${ts.key}`, draftedAt);
      const draftAudit = (
        action: string,
        when: Date,
        details: typeof schema.auditEvents.$inferInsert.details = null,
      ) => {
        audit.push({
          id: id(`audit:${action}:${ts.key}`, when),
          tenantId,
          createdAt: when,
          actorType: "system",
          actorId: "seed",
          action,
          targetType: "draft",
          targetId: draftId,
          requestId: null,
          details,
        });
      };
      draftAudit(
        "draft.created",
        draftedAt,
        d.editedBy?.length ? null : { bodyHash: hashBody(d.text), messageId: repliesTo.id },
      );
      const editedAt = new Date(draftedAt.getTime() + (d.editedBy?.length ?? 0) * 60_000);
      const discardedAt = d.status === "discarded" ? new Date(editedAt.getTime() + 60_000) : null;
      drafts.push({
        id: draftId,
        tenantId,
        conversationId,
        messageId: repliesTo.id,
        body: d.text,
        status: d.status,
        approvedAt,
        outboundMessageIdHeader: sentReply?.messageIdHeader ?? null,
        sentAt: sentReply?.sentAt ?? null,
        sentMessageId: sentReply?.id ?? null,
        createdAt: draftedAt,
        updatedAt: sentReply?.sentAt ?? discardedAt ?? editedAt,
      });
      (d.editedBy ?? []).forEach((name, i) => {
        const token = tokens.find((t) => t.name === name);
        if (!token) throw new Error(`demo conversation ${ts.key}: unknown token ${name}`);
        const when = new Date(draftedAt.getTime() + (i + 1) * 60_000);
        audit.push({
          id: id(`audit:draft.edited:${ts.key}:${i}`, when),
          tenantId,
          createdAt: when,
          actorType: "agent" as const,
          actorId: token.id,
          action: "draft.edited",
          targetType: "draft",
          targetId: draftId,
          requestId: null,
        });
      });
      if (approvedAt && sentReply) {
        draftAudit("draft.approved", approvedAt, { reviewedBodyHash: hashBody(d.text) });
        draftAudit("draft.sending", sentReply.createdAt, {
          fromStatus: "approved",
          toStatus: "send_uncertain",
        });
        draftAudit("draft.sent", sentReply.createdAt, {
          fromStatus: "send_uncertain",
          toStatus: "sent",
        });
      }
      if (discardedAt) draftAudit("draft.discarded", discardedAt);
      d.sources.forEach((ref, rank) => {
        const source = sourceBySlug.get(ref.slug);
        if (!source) throw new Error(`demo conversation ${ts.key}: unknown source ${ref.slug}`);
        citations.push({
          id: id(`citation:${ts.key}:${rank}`, draftedAt),
          tenantId,
          draftId,
          sourceId: source.id,
          title: source.title,
          url: null,
          visibility: source.visibility,
          // The first paragraph after the heading: what retrieval would have handed the model.
          excerpt: source.content.split("\n\n")[1] ?? source.content,
          rank,
          cited: ref.cited,
          createdAt: draftedAt,
          updatedAt: draftedAt,
        });
      });
    }

    return {
      key: spec.key,
      tenant,
      mailbox,
      memberships,
      customers,
      sources,
      tokens,
      audit,
      conversations,
      messages,
      drafts,
      citations,
    };
  });
  return { users, tenants };
}
