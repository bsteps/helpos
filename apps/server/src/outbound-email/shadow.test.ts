import { readFileSync, writeFileSync } from "node:fs";
import { brand } from "@helpos/brand";
import { describe, expect, it } from "vitest";
import { intendedToHeader, planDelivery } from "./shadow.ts";
import { buildReply, type ReplyEmail } from "./transport.ts";

const fixture = new URL("../../../../fixtures/email/outbound/shadow-reply.eml", import.meta.url);

const reply: ReplyEmail = {
  from: "support@acme.test",
  to: "jane@customer.test",
  subject: "Re: Cannot log in",
  text: "Hi Jane, we reset your session. Please try again.",
  messageId: "<reply-1@acme.test>",
  inReplyTo: "<login-1@customer.test>",
  references: ["<login-1@customer.test>"],
  date: new Date("2026-11-07T10:00:00Z"),
};
const shadowReplyTo = "no-reply@acme.test";
const shadowOn = { shadowMode: true, shadowRecipient: "owner@acme.test", shadowReplyTo };

/** Git checks the fixture out with LF (see .gitattributes), so line endings are compared as LF. */
const lf = (s: string) => s.replaceAll("\r\n", "\n");

describe("shadow mode delivery", () => {
  it("sends to the shadow recipient and never to the customer", () => {
    const delivery = planDelivery(reply, shadowOn);
    if (delivery.kind !== "shadow") throw new Error(`got ${delivery.kind}`);
    expect(delivery.email.to).toBe("owner@acme.test");
    expect(delivery.intendedTo).toBe("jane@customer.test");
    // Answering it can't reach the support mailbox and open a ticket.
    expect(delivery.email.replyTo).toBe(shadowReplyTo);
    expect(delivery.email.headers).toEqual({ [intendedToHeader]: "jane@customer.test" });
    expect(delivery.email.text.startsWith(`[${brand.name} shadow mode]`)).toBe(true);
    expect(delivery.email.text).toContain("It would have gone to: jane@customer.test");
    expect(delivery.email.text.endsWith(reply.text)).toBe(true);
  });

  it("sends nothing when shadow mode has no recipient", () => {
    expect(planDelivery(reply, { shadowMode: true, shadowRecipient: null, shadowReplyTo })).toEqual(
      {
        kind: "no_recipient",
      },
    );
  });

  it("sends the reply unchanged to the customer when shadow mode is off", () => {
    expect(
      planDelivery(reply, {
        shadowMode: false,
        shadowRecipient: "owner@acme.test",
        shadowReplyTo,
      }),
    ).toEqual({ kind: "customer", email: reply });
  });

  it("the shadowed email matches the fixture", async () => {
    const delivery = planDelivery(reply, shadowOn);
    if (delivery.kind !== "shadow") throw new Error(`got ${delivery.kind}`);
    const raw = lf(new TextDecoder().decode(await buildReply(delivery.email)));
    // UPDATE_FIXTURES=1 rewrites the fixture after an intended change; review the diff.
    if (process.env.UPDATE_FIXTURES) writeFileSync(fixture, raw);
    expect(raw).toBe(lf(readFileSync(fixture, "utf8")));
    // Header names are case-insensitive, and nodemailer normalises their case.
    const headers = (raw.split("\n\n")[0] ?? "").toLowerCase();
    expect(headers).toContain("\nto: owner@acme.test");
    expect(headers).toContain("\nreply-to: no-reply@acme.test");
    expect(headers).toContain(`${intendedToHeader.toLowerCase()}: jane@customer.test`);
  });
});
