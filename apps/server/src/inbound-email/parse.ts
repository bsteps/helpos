import PostalMime, { type Address } from "postal-mime";

/** What the rest of the feature needs from a raw email. Everything in it is untrusted data. */
export interface ParsedEmail {
  from: { address: string; name: string | null } | null;
  /** Delivered-To, then To, then Cc: lowercased, deduplicated, in that order. */
  recipients: string[];
  /** To addresses as written, for display. */
  to: string[];
  subject: string;
  text: string | null;
  html: string | null;
  /** Message-ID with its angle brackets, e.g. `<abc@mail.test>`. */
  messageId: string | null;
  inReplyTo: string | null;
  /** Message-IDs this email replies to: In-Reply-To first, then References newest-first. */
  threadIds: string[];
  references: string[];
  date: Date | null;
  attachments: ParsedAttachment[];
}

export interface ParsedAttachment {
  filename: string | null;
  contentType: string;
  contentId: string | null;
  bytes: Uint8Array;
}

export const noSubject = "(no subject)";

export async function parseEmail(raw: Uint8Array): Promise<ParsedEmail> {
  const email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
  const from = firstMailbox(email.from ? [email.from] : []);
  const to = flatten(email.to);
  const inReplyTo = messageIds(email.inReplyTo)[0] ?? null;
  const references = messageIds(email.references);
  const date = email.date ? new Date(email.date) : null;

  return {
    from: from ? { address: from.address.toLowerCase(), name: clean(from.name) || null } : null,
    recipients: unique(
      [
        email.deliveredTo ?? "",
        ...to.map((m) => m.address),
        ...flatten(email.cc).map((m) => m.address),
      ]
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a.includes("@")),
    ),
    to: to.map((m) => m.address),
    subject: clean(email.subject).trim() || noSubject,
    text: email.text === undefined ? null : clean(email.text),
    html: email.html === undefined ? null : clean(email.html),
    messageId: messageIds(email.messageId)[0] ?? null,
    inReplyTo,
    threadIds: unique([...(inReplyTo ? [inReplyTo] : []), ...references.toReversed()]),
    references,
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    attachments: email.attachments.map((a) => ({
      filename: a.filename === null ? null : clean(a.filename),
      contentType: a.mimeType || "application/octet-stream",
      contentId: a.contentId ?? null,
      bytes:
        typeof a.content === "string"
          ? new TextEncoder().encode(a.content)
          : new Uint8Array(a.content),
    })),
  };
}

type Mailbox = { name: string; address: string };

function flatten(addresses: Address[] | undefined): Mailbox[] {
  return (addresses ?? []).flatMap((a): Mailbox[] =>
    a.group ? a.group : a.address ? [{ name: a.name, address: a.address }] : [],
  );
}

function firstMailbox(addresses: Address[]): Mailbox | undefined {
  return flatten(addresses).find((m) => m.address.includes("@"));
}

/** Extracts `<id>` tokens. Headers are untrusted, so anything else in them is ignored. */
function messageIds(header: string | undefined): string[] {
  return (header?.match(/<[^<>\s]{1,998}>/g) ?? []).slice(0, 100);
}

/**
 * Postgres text can't hold NUL bytes. Without this, one such email fails every retry from
 * the provider. The raw MIME keeps the original bytes.
 */
function clean(value: string | undefined): string {
  return (value ?? "").replaceAll("\0", "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
