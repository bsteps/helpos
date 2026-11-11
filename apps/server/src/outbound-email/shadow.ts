import { brand } from "@helpos/brand";
import type { ReplyEmail } from "./transport.ts";

/** Carries the customer address a shadowed reply would have gone to. */
export const intendedToHeader = `X-${brand.name}-Intended-To`;

export type ShadowSettings = {
  shadowMode: boolean;
  shadowRecipient: string | null;
  /**
   * A no-reply address for shadowed mail. If the owner answers a shadowed reply, the answer
   * must not land in the support mailbox and open a conversation of its own.
   */
  shadowReplyTo: string;
};

export type Delivery =
  | { kind: "customer"; email: ReplyEmail }
  | { kind: "shadow"; email: ReplyEmail; intendedTo: string }
  /** Shadow mode is on but nobody is set to receive: nothing may be sent. */
  | { kind: "no_recipient" };

/** The banner at the top of a shadowed reply, so the reader knows it never reached the customer. */
export function shadowBanner(intendedTo: string): string {
  return [
    `[${brand.name} shadow mode] This reply was NOT sent to the customer.`,
    `It would have gone to: ${intendedTo}`,
    "----",
    "",
  ].join("\n");
}

/**
 * Decides who actually gets a reply. In shadow mode it goes to the shadow recipient only, with
 * the intended customer named in the body and a header. The customer is never a recipient.
 */
export function planDelivery(email: ReplyEmail, settings: ShadowSettings): Delivery {
  if (!settings.shadowMode) return { kind: "customer", email };
  if (!settings.shadowRecipient) return { kind: "no_recipient" };
  return {
    kind: "shadow",
    intendedTo: email.to,
    email: {
      ...email,
      to: settings.shadowRecipient,
      replyTo: settings.shadowReplyTo,
      text: `${shadowBanner(email.to)}${email.text}`,
      headers: { [intendedToHeader]: email.to },
    },
  };
}
