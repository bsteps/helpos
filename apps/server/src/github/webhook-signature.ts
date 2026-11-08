import { createHmac, timingSafeEqual } from "node:crypto";

/** `X-Hub-Signature-256` for `body`: `sha256=` and the hex HMAC-SHA256 under the secret. */
export function signWebhook(secret: string, body: Uint8Array | string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
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
  const given = /^sha256=([0-9a-fA-F]{64})$/.exec(header ?? "")?.[1];
  if (!given) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(Buffer.from(given, "hex"), expected);
}
