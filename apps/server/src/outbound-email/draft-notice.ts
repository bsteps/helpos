import { brand } from "@helpos/brand";
import MailComposer from "nodemailer/lib/mail-composer";

/** How much of the customer's message a notice quotes. Enough to recognise it, no more. */
export const noticeSnippetLength = 160;

/** At most one notice per conversation in this window, however many drafts it gets. */
export const noticeWindowMinutes = 15;

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

/**
 * The subject is fixed: customer text never goes there, because subjects show up in
 * notifications and lock screens.
 */
export const noticeSubject = `[${brand.name}] A draft reply is waiting for your approval`;

/** One line, no control characters, cut at a word boundary when possible. */
export function snippet(text: string, max = noticeSnippetLength): string {
  // Bounded first: the link patterns below backtrack, and a message can be megabytes long.
  // Four times the snippet leaves room for what the replacements shorten.
  const visible = Array.from(text.slice(0, max * 4), (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : ch;
  }).join("");
  // Bidi overrides could make the quote read differently from what the customer wrote.
  const flat = visible
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    // C1 controls (NEL can break a line), zero-width and line/paragraph separators.
    .replace(/[\u0080-\u009F\u200B-\u200F\u2028\u2029\uFEFF]/g, " ")
    // A lone surrogate left by the cut above.
    .replace(/[\uD800-\uDBFF]$/, "")
    // The notice comes from the workspace's own address, so a customer's link must not look
    // like one we sent. The full message is on the conversation.
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link]")
    // Bare domains too: mail clients autolink them. Catches some file names; that's fine here.
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b\S*/gi, "[link]")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  // Don't cut an emoji (a surrogate pair) in half.
  const last = flat.charCodeAt(max - 1);
  const cut = flat.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function noticeText(notice: Pick<DraftNotice, "conversationUrl" | "customerText">): string {
  const quoted = snippet(notice.customerText);
  return [
    "A draft reply is waiting for your approval. Nothing is sent until someone approves it.",
    "",
    ...(quoted ? ["The customer wrote:", `> ${quoted}`, ""] : []),
    `Review it: ${notice.conversationUrl}`,
    "",
    "Replies to this email are not read.",
    `You get at most one of these per conversation every ${noticeWindowMinutes} minutes. Sent by ${brand.name}.`,
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
