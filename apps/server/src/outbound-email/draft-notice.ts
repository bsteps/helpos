import { brand } from "@helpos/brand";
import MailComposer from "nodemailer/lib/mail-composer";

/** How much of the customer's message a notice quotes. Enough to recognise it, no more. */
export const noticeSnippetLength = 160;

export interface DraftNotice {
  from: string;
  /**
   * Not a helpdesk mailbox, so an owner who answers the notice doesn't open a ticket that the
   * AI then drafts a reply to.
   */
  replyTo: string;
  to: string[];
  ticketUrl: string;
  /** The customer's message. Quoted as a short plain-text snippet, never in the subject. */
  customerText: string;
  messageId: string;
  date: Date;
}

/**
 * The subject is fixed: customer text never goes there, because subjects show up in
 * notifications and lock screens.
 */
export const noticeSubject = `[${brand.name}] A draft reply is waiting for your approval`;

/** One line, no control characters, cut at a word boundary when possible. */
export function snippet(text: string, max = noticeSnippetLength): string {
  const visible = Array.from(text, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : ch;
  }).join("");
  const flat = visible.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function noticeText(notice: Pick<DraftNotice, "ticketUrl" | "customerText">): string {
  const quoted = snippet(notice.customerText);
  return [
    "A draft reply is waiting for your approval. Nothing is sent until someone approves it.",
    "",
    ...(quoted ? ["The customer wrote:", `> ${quoted}`, ""] : []),
    `Review it: ${notice.ticketUrl}`,
    "",
    "Replies to this email are not read.",
    `You get at most one of these per ticket every 15 minutes. Sent by ${brand.name}.`,
  ].join("\n");
}

/** Raw MIME, plain text only. */
export function buildDraftNotice(notice: DraftNotice): Promise<Uint8Array> {
  const composer = new MailComposer({
    from: notice.from,
    replyTo: notice.replyTo,
    to: notice.to,
    subject: noticeSubject,
    text: noticeText(notice),
    messageId: notice.messageId,
    date: notice.date,
    // Tells well-behaved auto-responders not to answer a machine notice.
    headers: { "Auto-Submitted": "auto-generated" },
  });
  return new Promise((resolve, reject) => {
    composer.compile().build((error, message) => {
      if (error) reject(error);
      else resolve(new Uint8Array(message));
    });
  });
}
