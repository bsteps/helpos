import MailComposer from "nodemailer/lib/mail-composer";
import { noticeSubject, noticeText } from "./draft-notice.ts";

export interface ReplyEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  /** Our own Message-ID, e.g. `<id@acme.test>`. */
  messageId: string;
  /** The Message-ID of the email we answer, so mail clients thread the reply. */
  inReplyTo: string | null;
  references: string[];
  date: Date;
  /** Where answers to this email go, if not to `from`. */
  replyTo?: string;
  /** Extra headers, e.g. the intended recipient of a shadowed reply. */
  headers?: Record<string, string>;
}

export interface DraftNotice {
  from: string;
  /**
   * Not a helpdesk mailbox, so an owner who answers the notice doesn't open a conversation that the
   * AI then drafts a reply to.
   */
  replyTo: string;
  to: string;
  conversationUrl: string;
  /** The customer's message. Quoted as a short plain-text snippet, never in the subject. */
  customerText: string;
  messageId: string;
  date: Date;
}

export type OutboundEmail =
  | (ReplyEmail & { kind: "reply" })
  | (DraftNotice & { kind: "draft_notice" });

export function mailboxDomain(mailbox: string): string {
  return mailbox.split("@").pop() ?? "localhost";
}

export function outboundMessageId(input: {
  kind: OutboundEmail["kind"];
  domain: string;
  id: string;
}): string {
  return `<${input.kind === "draft_notice" ? "notice-" : ""}${input.id}@${input.domain}>`;
}

export function noticeReplyTo(mailbox: string): string {
  const domain = mailboxDomain(mailbox).toLowerCase();
  const address = `no-reply@${domain}`;
  return address === mailbox.toLowerCase() ? `no-reply-notices@${domain}` : address;
}

export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

/** Plain text only: AI output is not rendered as HTML (#52). */
export function composeEmail(email: OutboundEmail): Promise<Uint8Array> {
  const composer = new MailComposer({
    from: email.from,
    to: email.to,
    subject: email.kind === "reply" ? email.subject : noticeSubject,
    text: email.kind === "reply" ? email.text : noticeText(email),
    messageId: email.messageId,
    date: email.date,
    ...(email.kind === "reply" && email.inReplyTo ? { inReplyTo: email.inReplyTo } : {}),
    ...(email.kind === "reply" && email.references.length > 0
      ? { references: email.references }
      : {}),
    ...(email.replyTo ? { replyTo: email.replyTo } : {}),
    ...(email.kind === "draft_notice"
      ? { headers: { "Auto-Submitted": "auto-generated" } }
      : email.headers
        ? { headers: email.headers }
        : {}),
  });
  return new Promise((resolve, reject) => {
    composer.compile().build((error, message) => {
      if (error) reject(error);
      else resolve(new Uint8Array(message));
    });
  });
}
