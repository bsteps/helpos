import nodemailer from "nodemailer";

/** Sends one already-built message. Swappable (ADR 0002): SMTP now, provider APIs later. */
export interface EmailTransport {
  send(message: { from: string; to: string[]; raw: Uint8Array }): Promise<void>;
  close(): void;
}

export class SendRejected extends Error {}

/** SMTP via nodemailer. Locally `smtp://localhost:1025` is Mailpit, which catches everything. */
export function createSmtpTransport(url: string): EmailTransport {
  const transporter = nodemailer.createTransport(url);
  return {
    async send({ from, to, raw }) {
      // The envelope is set explicitly, so the recipients are exactly these, whatever the
      // headers in `raw` say.
      try {
        await transporter.sendMail({ envelope: { from, to }, raw: Buffer.from(raw) });
      } catch (error) {
        if (
          error instanceof Error &&
          "responseCode" in error &&
          typeof error.responseCode === "number" &&
          error.responseCode >= 400 &&
          error.responseCode <= 599
        ) {
          throw new SendRejected("SMTP refused the message", { cause: error });
        }
        throw error;
      }
    },
    close: () => transporter.close(),
  };
}
