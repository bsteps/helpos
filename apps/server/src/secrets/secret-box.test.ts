import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSecretBox, parseEncryptionKey, SecretBoxError } from "./secret-box.ts";

const key = randomBytes(32);
const box = createSecretBox(key);
const token = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz";
const binding = {
  tenantId: "0190a0b0-0000-7000-8000-000000000001",
  purpose: "github-token",
} as const;

describe("secret box", () => {
  it("round-trips a value, and the stored form never contains it", () => {
    const sealed = box.seal(token, binding);
    expect(sealed).not.toContain(token);
    expect(sealed).not.toContain(Buffer.from(token).toString("base64"));
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(box.open(sealed, binding)).toBe(token);
  });

  it("uses a fresh IV every time, so the same token never looks the same twice", () => {
    expect(box.seal(token, binding)).not.toBe(box.seal(token, binding));
  });

  it("won't open in another workspace", () => {
    const sealed = box.seal(token, binding);
    const other = { ...binding, tenantId: "0190a0b0-0000-7000-8000-000000000002" };
    expect(() => box.open(sealed, other)).toThrow(SecretBoxError);
  });

  it("won't open as another kind of secret", () => {
    const sealed = box.seal(token, binding);
    expect(() => box.open(sealed, { ...binding, purpose: "github-webhook-secret" })).toThrow(
      SecretBoxError,
    );
  });

  it("won't open with another key", () => {
    const sealed = box.seal(token, binding);
    expect(() => createSecretBox(randomBytes(32)).open(sealed, binding)).toThrow(SecretBoxError);
  });

  it("detects a changed ciphertext", () => {
    const [v, iv, tag, ct] = box.seal(token, binding).split(".");
    const flipped = Buffer.from(ct ?? "", "base64url");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => box.open([v, iv, tag, flipped.toString("base64url")].join("."), binding)).toThrow(
      SecretBoxError,
    );
  });

  it("refuses something that isn't a sealed value", () => {
    expect(() => box.open(token, binding)).toThrow(SecretBoxError);
    expect(() => box.open("v1.a.b", binding)).toThrow(SecretBoxError);
  });
});

describe("parseEncryptionKey", () => {
  it("accepts 32 bytes as hex or base64", () => {
    expect(parseEncryptionKey(key.toString("hex"))).toEqual(key);
    expect(parseEncryptionKey(key.toString("base64"))).toEqual(key);
    expect(parseEncryptionKey(key.toString("base64url"))).toEqual(key);
  });

  it("refuses anything shorter, longer or not a key", () => {
    expect(parseEncryptionKey(randomBytes(16).toString("hex"))).toBeNull();
    expect(parseEncryptionKey(randomBytes(48).toString("base64"))).toBeNull();
    expect(parseEncryptionKey("change-me")).toBeNull();
  });
});
