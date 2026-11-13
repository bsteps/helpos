import { describe, expect, it } from "vitest";
import { bearerToken } from "../tokens/token.ts";
import { buildDemoData } from "./demo-data.ts";

describe("buildDemoData", () => {
  it("builds exactly the same data every time", () => {
    expect(buildDemoData()).toEqual(buildDemoData());
  });

  it("keeps IDs and tokens stable across runs and machines", () => {
    // Pinned values: if these change, every e2e test and doc that uses the demo data breaks.
    const [northwind, lumen] = buildDemoData().tenants;
    expect(northwind?.tenant.id).toMatchInlineSnapshot(`"019b16b9-4800-77ed-b1f4-2fdfb7b7f42f"`);
    expect(lumen?.tokens[0]?.token).toMatchInlineSnapshot(
      `"hos_TU5639iw_QGr7CMt9Iq-O5YtF9phBBfDxuYBDC3opmU"`,
    );
  });

  it("preserves conversation IDs from databases seeded before the rename", () => {
    expect(buildDemoData().tenants.map((t) => t.conversations.map((c) => c.id))).toEqual([
      [
        "019bb1a6-0470-7a4b-9bab-c3880f4dd3c3",
        "019bb24b-50d8-763b-a58a-d6e1396698c8",
        "019bb6cc-4ce8-781b-8186-9f3a32bc24b2",
        "019bb7a8-87d0-7713-95e4-62bc4a578ba9",
        "019bbbf3-2db8-77d4-9e93-7bcc94e128ca",
        "019bbcce-d048-749e-a3b6-153621d7ca42",
        "019bbdaa-ebf0-7810-b68e-7a2cc1860453",
        "019bbc61-2228-7a78-a518-30b7916c4932",
        "019bc03d-9138-71da-9d0f-cea64a47f424",
      ],
      [
        "019bb1dd-6c08-7014-a625-c342855ab267",
        "019bb2f0-2428-73cf-b35d-b426143741b6",
        "019bb703-e360-70bc-a84b-0f7fb2918d40",
        "019bbb85-29a8-7114-ade2-e121e52b2557",
        "019bbbbb-ba68-7fbb-8bd4-5c6911a107eb",
      ],
    ]);
  });

  it("seeds two workspaces with users, tokens, conversations, drafts and knowledge", () => {
    const { tenants, users } = buildDemoData();
    expect(tenants).toHaveLength(2);
    expect(new Set(users.map((u) => u.email)).size).toBe(users.length);
    for (const t of tenants) {
      expect(t.memberships.some((m) => m.role === "owner")).toBe(true);
      expect(t.tokens.length).toBeGreaterThan(0);
      expect(t.conversations.length).toBeGreaterThan(3);
      expect(t.sources.length).toBeGreaterThan(0);
      for (const status of ["pending", "sent"]) {
        expect(t.drafts.some((d) => d.status === status)).toBe(true);
      }
    }
  });

  it("makes tokens the API accepts", () => {
    for (const t of buildDemoData().tenants) {
      for (const k of t.tokens) expect(bearerToken(`Bearer ${k.token}`)).toBe(k.token);
    }
  });

  it("uses only made-up addresses on reserved domains", () => {
    const { tenants, users } = buildDemoData();
    const emails = [
      ...users.map((u) => u.email),
      ...tenants.flatMap((t) => [t.mailbox.address, ...t.customers.map((c) => c.email)]),
    ];
    for (const email of emails) expect(email).toMatch(/@[a-z0-9.-]+\.test$/);
  });

  it("gives no two rows the same ID", () => {
    const ids = buildDemoData().tenants.flatMap((t) => [
      t.tenant.id,
      t.mailbox.id,
      ...[
        t.memberships,
        t.customers,
        t.sources,
        t.tokens,
        t.audit,
        t.conversations,
        t.messages,
        t.drafts,
        t.citations,
      ]
        .flat()
        .map((r) => r.id),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
