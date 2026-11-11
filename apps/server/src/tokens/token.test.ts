import { createHash, timingSafeEqual } from "node:crypto";
import type { ApiTokenRecord } from "@helpos/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentTokens } from "./authenticate.ts";
import { bearerToken, generateToken, hashesMatch, hashToken } from "./token.ts";

// Wraps the real function, so the tests can see that the compare goes through it.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

beforeEach(() => {
  vi.mocked(timingSafeEqual).mockClear();
});

describe("generateToken", () => {
  it("is hos_ and 32 random bytes, and only its SHA-256 is kept", () => {
    const { token, hash } = generateToken();
    expect(token).toMatch(/^hos_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token.slice(4), "base64url")).toHaveLength(32);
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hash).not.toContain(token.slice(4));
  });

  it("never repeats", () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateToken().token));
    expect(tokens.size).toBe(1000);
  });
});

describe("bearerToken", () => {
  const token = generateToken().token;

  it("reads a hos_ token from a Bearer header, whatever the scheme's case", () => {
    expect(bearerToken(`Bearer ${token}`)).toBe(token);
    expect(bearerToken(`bearer ${token}`)).toBe(token);
  });

  it.each([
    ["no header", null],
    ["an empty header", ""],
    ["another scheme", `Basic ${token}`],
    ["no scheme", token],
    ["another prefix", `Bearer xyz_${token.slice(4)}`],
    ["a short token", `Bearer ${token.slice(0, -1)}`],
    ["a long token", `Bearer ${token}A`],
    ["two tokens", `Bearer ${token} ${token}`],
    ["characters outside base64url", `Bearer hos_${"+".repeat(43)}`],
  ])("is null for %s", (_, header) => {
    expect(bearerToken(header)).toBeNull();
  });
});

describe("hashesMatch", () => {
  const a = hashToken("a");
  const b = hashToken("b");

  it("compares with crypto.timingSafeEqual", () => {
    expect(hashesMatch(a, a)).toBe(true);
    expect(hashesMatch(a, b)).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
  });

  it("is false, without throwing, for anything that isn't a SHA-256", () => {
    expect(hashesMatch(a, a.slice(0, 62))).toBe(false);
    expect(hashesMatch("", "")).toBe(false);
    expect(hashesMatch(a, `${a}00`)).toBe(false);
  });
});

describe("agentTokens", () => {
  const { token, hash } = generateToken();
  const record: ApiTokenRecord = {
    id: "0190a000-0000-7000-8000-00000000000a",
    tenantId: "0190a000-0000-7000-8000-00000000000b",
    name: "triage-bot",
    tokenHash: hash,
    scopes: ["conversations:read", "drafts:write"],
    revokedAt: null,
  };
  const request = (authorization?: string) =>
    new Request("http://x.test/", authorization ? { headers: { authorization } } : {});
  const authenticateWith = (found: ApiTokenRecord | null) => {
    const resolveApiToken = vi.fn(async (_hash: string) => found);
    return { authenticate: agentTokens({ resolveApiToken }), resolveApiToken };
  };

  it("resolves a token to its workspace, its agent identity and exactly its scopes", async () => {
    const { authenticate, resolveApiToken } = authenticateWith(record);
    expect(await authenticate(request(`Bearer ${token}`))).toEqual({
      tenantId: record.tenantId,
      actor: { type: "agent", id: record.id },
      scopes: new Set(["conversations:read", "drafts:write"]),
    });
    // The database only ever sees the hash, never the token.
    expect(resolveApiToken).toHaveBeenCalledWith(hash);
    expect(timingSafeEqual).toHaveBeenCalledOnce();
  });

  it("refuses an unknown token", async () => {
    expect(await authenticateWith(null).authenticate(request(`Bearer ${token}`))).toBeNull();
  });

  it("refuses a revoked token", async () => {
    const revoked = { ...record, revokedAt: new Date() };
    expect(await authenticateWith(revoked).authenticate(request(`Bearer ${token}`))).toBeNull();
  });

  it("refuses a row whose hash isn't the token's", async () => {
    const other = { ...record, tokenHash: hashToken("something else") };
    expect(await authenticateWith(other).authenticate(request(`Bearer ${token}`))).toBeNull();
  });

  it("doesn't reach the database for a missing or malformed token", async () => {
    const { authenticate, resolveApiToken } = authenticateWith(record);
    expect(await authenticate(request())).toBeNull();
    expect(await authenticate(request("Bearer not-a-token"))).toBeNull();
    expect(resolveApiToken).not.toHaveBeenCalled();
  });
});
