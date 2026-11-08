import { createHmac, timingSafeEqual } from "node:crypto";

/** What GitHub sends in `X-Hub-Signature-256`; anything else is refused before any work. */
export const signatureHeader = /^sha256=([0-9a-fA-F]{64})$/;

const hmac = (secret: string, body: Uint8Array | string) =>
  createHmac("sha256", secret).update(body).digest();

/** `X-Hub-Signature-256` for `body`: `sha256=` and the hex HMAC-SHA256 under the secret. */
export function signWebhook(secret: string, body: Uint8Array | string): string {
  return `sha256=${hmac(secret, body).toString("hex")}`;
}

/**
 * True when `header` is GitHub's signature of exactly these bytes. Checked over the raw body,
 * never a re-serialised parse, and compared in constant time.
 */
export function signatureMatches(
  secret: string,
  body: Uint8Array,
  header: string | undefined,
): boolean {
  const given = signatureHeader.exec(header ?? "")?.[1];
  if (!given) return false;
  return timingSafeEqual(Buffer.from(given, "hex"), hmac(secret, body));
}
