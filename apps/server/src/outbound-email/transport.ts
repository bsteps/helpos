import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";

/** Sends one already-built message. Swappable (ADR 0002): SMTP now, provider APIs later. */
export interface EmailTransport {
  send(message: { from: string; to: string[]; raw: Uint8Array }): Promise<void>;
  close(): void;
}

/** SMTP via nodemailer. Locally `smtp://localhost:1025` is Mailpit, which catches everything. */
export function createSmtpTransport(url: string): EmailTransport {
  const transporter = nodemailer.createTransport(url);
  return {
    async send({ from, to, raw }) {
      // The envelope is set explicitly, so the recipients are exactly these, whatever the
      // headers in `raw` say.
      await transporter.sendMail({ envelope: { from, to }, raw: Buffer.from(raw) });
    },
    close: () => transporter.close(),
  };
}

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

/** "Re: " once, never "Re: Re: ". */
export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

/** Builds the raw MIME. Plain text only: AI output is not rendered as HTML (#52). */
export function buildReply(email: ReplyEmail): Promise<Uint8Array> {
  const composer = new MailComposer({
    from: email.from,
    to: email.to,
    subject: email.subject,
    text: email.text,
    messageId: email.messageId,
    date: email.date,
    ...(email.inReplyTo ? { inReplyTo: email.inReplyTo } : {}),
    ...(email.references.length > 0 ? { references: email.references } : {}),
    ...(email.replyTo ? { replyTo: email.replyTo } : {}),
    ...(email.headers ? { headers: email.headers } : {}),
  });
  return new Promise((resolve, reject) => {
    composer.compile().build((error, message) => {
      if (error) reject(error);
      else resolve(new Uint8Array(message));
    });
  });
}
