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

  it("seeds two workspaces with users, tokens, tickets, drafts and knowledge", () => {
    const { tenants, users } = buildDemoData();
    expect(tenants).toHaveLength(2);
    expect(new Set(users.map((u) => u.email)).size).toBe(users.length);
    for (const t of tenants) {
      expect(t.memberships.some((m) => m.role === "owner")).toBe(true);
      expect(t.tokens.length).toBeGreaterThan(0);
      expect(t.tickets.length).toBeGreaterThan(3);
      expect(t.sources.length).toBeGreaterThan(0);
      for (const status of ["pending", "sent"]) {
        expect(t.drafts.some((d) => d.status === status)).toBe(true);
      }
    }
  });

  it("links a demo ticket to a GitHub issue, and gives an agent github:write", () => {
    const lumen = buildDemoData().tenants.find((t) => t.key === "lumen");
    expect(lumen?.githubIssues).toEqual([
      expect.objectContaining({
        repo: "lumen-analytics/dashboard",
        issueNumber: 412,
        state: "open",
      }),
    ]);
    expect(lumen?.tokens.some((t) => t.scopes.includes("github:write"))).toBe(true);
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
        t.tickets,
        t.messages,
        t.drafts,
        t.citations,
        t.githubIssues,
      ]
        .flat()
        .map((r) => r.id),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
