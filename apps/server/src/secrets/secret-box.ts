import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypts integration secrets (a GitHub token, a webhook secret) before they are stored, with
 * AES-256-GCM and the one server key in HELPOS_ENCRYPTION_KEY. Envelope encryption replaces the
 * single key before the first release (#15).
 *
 * Every value is bound to where it belongs: the workspace and what it is (`github-token`), as
 * GCM's additional data. A ciphertext copied into another workspace's row, or from the token
 * column into the secret column, fails to open instead of being used there.
 */
export interface SecretBox {
  seal(plaintext: string, binding: SecretBinding): string;
  /** Throws SecretBoxError if the value was changed, or belongs to another binding or key. */
  open(sealed: string, binding: SecretBinding): string;
}

type SecretBinding = { tenantId: string; purpose: "github-token" | "github-webhook-secret" };

export class SecretBoxError extends Error {
  override readonly name = "SecretBoxError";
}

const version = "v1";
const ivBytes = 12;
const tagBytes = 16;

/**
 * The key: 32 bytes, as 64 hex characters or as base64 (`openssl rand -base64 32`). Null when
 * it is neither, so the caller can name the variable without printing its value.
 */
export function parseEncryptionKey(raw: string): Buffer | null {
  const value = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) return null;
  const key = Buffer.from(value, "base64");
  return key.length === 32 ? key : null;
}

const aad = (b: SecretBinding) => Buffer.from(`${version}:${b.purpose}:${b.tenantId}`, "utf8");

export function createSecretBox(key: Buffer): SecretBox {
  if (key.length !== 32) throw new SecretBoxError("encryption key must be 32 bytes");
  return {
    seal(plaintext, binding) {
      // A fresh random IV every time: GCM must never reuse one with the same key.
      const iv = randomBytes(ivBytes);
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: tagBytes });
      cipher.setAAD(aad(binding));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [version, iv, cipher.getAuthTag(), ciphertext]
        .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
        .join(".");
    },
    open(sealed, binding) {
      const [v, iv, tag, ciphertext, ...rest] = sealed.split(".");
      if (v !== version || !iv || !tag || ciphertext === undefined || rest.length > 0) {
        throw new SecretBoxError("not a sealed value");
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), {
          authTagLength: tagBytes,
        });
        decipher.setAAD(aad(binding));
        decipher.setAuthTag(Buffer.from(tag, "base64url"));
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertext, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // Node's message says nothing secret, but one fixed message is easier to reason about.
        throw new SecretBoxError("sealed value could not be opened");
      }
    },
  };
}
