import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { schema } from "@helpos/db";

/** What a token can be granted. `scopes` is built from this list, so each one is a scope the API checks. */
export const tokenScopes = schema.apiTokenScopes;

/** Recognisable in logs and by secret scanners, so a leaked token is easy to spot. */
const tokenPrefix = "hos_";
/** `hos_` and 32 random bytes in base64url (43 characters, no padding). */
const tokenPattern = /^hos_[A-Za-z0-9_-]{43}$/;
const bearerPattern = /^Bearer (\S+)$/i;

/** A new token and the hash that is stored. The token itself is shown once and never stored. */
export function generateToken(): { token: string; hash: string } {
  const token = tokenPrefix + randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

/**
 * Hex SHA-256. A plain hash is enough: the token is 32 random bytes, so there is nothing to
 * brute-force, unlike a password.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The token in an `Authorization: Bearer hos_…` header, or null when it isn't one. */
export function bearerToken(authorization: string | null | undefined): string | null {
  const token = authorization?.match(bearerPattern)?.[1];
  return token && tokenPattern.test(token) ? token : null;
}

/**
 * Compares two hex SHA-256 hashes in constant time. The database finds a token by its hash,
 * so its index lookup can only leak timing about a hash, never about the token behind it; the
 * check in our own code doesn't leak even that.
 */
export function hashesMatch(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  // timingSafeEqual throws on different lengths. A wrong length is not a secret, so this
  // early return gives nothing away.
  if (x.length !== 32 || y.length !== 32) return false;
  return timingSafeEqual(x, y);
}
