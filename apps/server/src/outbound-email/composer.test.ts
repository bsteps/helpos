import { describe, expect, it } from "vitest";
import fixtures from "../../../../fixtures/email/outbound/composer.json" with { type: "json" };
import {
  composeEmail,
  mailboxDomain,
  noticeReplyTo,
  outboundMessageId,
  type ReplyEmail,
  replySubject,
} from "./composer.ts";
import { planDelivery } from "./shadow.ts";

const reply: ReplyEmail = {
  from: "support@Acme.test",
  to: "jane@customer.test",
  subject: "Re: Cannot log in",
  text: "Hi Jane, we reset your session. Please try again.\nThanks!",
  messageId: "<reply-213@Acme.test>",
  inReplyTo: "<login-1@customer.test>",
  references: ["<first@customer.test>", "<login-1@customer.test>"],
  date: new Date("2026-11-07T10:00:00Z"),
};

const unicode = {
  ...reply,
  subject: "Re: Connexion à Montréal 日本語",
  text: "Bonjour Zoë,\nVotre accès est rétabli. 日本語の返信です。\nMerci 👋",
};
const shadow = planDelivery(unicode, {
  shadowMode: true,
  shadowRecipient: "owner@acme.test",
  shadowReplyTo: "no-reply@acme.test",
});
if (shadow.kind !== "shadow") throw new Error("expected shadow delivery");

const cases = [
  { name: "customer-reply", build: () => composeEmail({ kind: "reply", ...reply }) },
  { name: "unicode-reply", build: () => composeEmail({ kind: "reply", ...unicode }) },
  {
    name: "unthreaded-reply",
    build: () => composeEmail({ kind: "reply", ...reply, inReplyTo: null, references: [] }),
  },
  { name: "unicode-shadow-reply", build: () => composeEmail({ kind: "reply", ...shadow.email }) },
  {
    name: "empty-notice",
    build: () =>
      composeEmail({
        kind: "draft_notice",
        from: reply.from,
        to: "owner@acme.test",
        replyTo: "no-reply@acme.test",
        conversationUrl: "https://acme.test/helpdesk/conversations/213",
        customerText: "",
        messageId: "<notice-213@Acme.test>",
        date: reply.date,
      }),
  },
] satisfies { name: keyof typeof fixtures; build: () => Promise<Uint8Array> }[];

describe("outbound MIME bytes captured before #213", () => {
  it.each(cases)("preserves $name", async ({ name, build }) => {
    const raw = await build();
    expect(Buffer.from(raw)).toEqual(Buffer.from(fixtures[name]));
  });
});

describe("outbound header construction", () => {
  it("preserves reply and notice ID formats and domain casing", () => {
    const domain = mailboxDomain("support@Acme.test");
    const id = "0190f0a0-0000-7000-8000-000000000001";
    expect(outboundMessageId({ kind: "reply", domain, id })).toBe(`<${id}@Acme.test>`);
    expect(outboundMessageId({ kind: "draft_notice", domain, id })).toBe(
      `<notice-${id}@Acme.test>`,
    );
  });

  it.each([
    ["support@Acme.test", "no-reply@acme.test"],
    ["NO-REPLY@Acme.test", "no-reply-notices@acme.test"],
    ["no-reply-notices@Acme.test", "no-reply@acme.test"],
  ])("keeps answers to %s away from the support mailbox", (mailbox, expected) => {
    expect(noticeReplyTo(mailbox)).toBe(expected);
  });

  it.each([
    ["Help", "Re: Help"],
    ["Re: Help", "Re: Help"],
    ["  rE: Help", "  rE: Help"],
  ])("preserves reply subject %s", (subject, expected) => {
    expect(replySubject(subject)).toBe(expected);
  });
});
