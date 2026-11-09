import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The dashboard and the agent API must have the same capabilities. Every API
// operation needs a call from the dashboard, or an entry here saying why not.
// `machine`: only another system calls it, so it stays. `gap`: a missing
// screen; delete the entry when its issue lands. This list should only shrink.
type ApiOnlyReason = { kind: "machine"; caller: string } | { kind: "gap"; issue: number };

const apiOnly: Record<string, ApiOnlyReason> = {
  "POST /v1/inbound/email": { kind: "machine", caller: "email provider" },
  "POST /v1/integrations/github/webhook": { kind: "machine", caller: "GitHub" },
  "GET /v1/knowledge/sources": { kind: "gap", issue: 132 },
  "POST /v1/knowledge/sources": { kind: "gap", issue: 132 },
  "PATCH /v1/knowledge/sources/{id}": { kind: "gap", issue: 132 },
  "DELETE /v1/knowledge/sources/{id}": { kind: "gap", issue: 132 },
  "POST /v1/knowledge/sources/{id}/reingest": { kind: "gap", issue: 132 },
  "GET /v1/tokens": { kind: "gap", issue: 12 },
  "POST /v1/tokens": { kind: "gap", issue: 12 },
  "DELETE /v1/tokens/{id}": { kind: "gap", issue: 12 },
  "GET /v1/workspace/shadow-mode": { kind: "gap", issue: 133 },
  "PATCH /v1/workspace/shadow-mode": { kind: "gap", issue: 133 },
  "GET /v1/ai-usage": { kind: "gap", issue: 133 },
};

const httpMethods = new Set(["get", "post", "put", "patch", "delete"]);

function specOperations(): string[] {
  const spec: { paths: Record<string, Record<string, unknown>> } = JSON.parse(
    readFileSync(new URL("./openapi.json", import.meta.url), "utf8"),
  );
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((method) => httpMethods.has(method))
      .map((method) => `${method.toUpperCase()} ${path}`),
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.(test|gen)\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function dashboardCalls(): Set<string> {
  const calls = new Set<string>();
  const src = fileURLToPath(new URL("..", import.meta.url));
  const callPattern = /\bapi\.(GET|POST|PUT|PATCH|DELETE)\(\s*["'`](\/[^"'`]+)["'`]/g;
  for (const file of sourceFiles(src)) {
    for (const match of readFileSync(file, "utf8").matchAll(callPattern)) {
      calls.add(`${match[1]} ${match[2]}`);
    }
  }
  return calls;
}

describe("dashboard and API parity", () => {
  const operations = specOperations();
  const calls = dashboardCalls();

  it("finds the operations and the dashboard's calls", () => {
    // Guards against a broken scan making every check below pass vacuously.
    expect(operations.length).toBeGreaterThan(20);
    expect(calls.size).toBeGreaterThan(10);
  });

  it("calls every API operation from the dashboard, unless it is listed as API-only", () => {
    const missing = operations.filter((op) => !calls.has(op) && !(op in apiOnly));
    // If this fails: add the screen that uses it, or (only for machine callers) an apiOnly entry.
    expect(missing).toEqual([]);
  });

  it("has no stale API-only entries", () => {
    const known = new Set(operations);
    const stale = Object.keys(apiOnly).filter((op) => calls.has(op) || !known.has(op));
    // If this fails: the dashboard now calls it (or it was removed), so delete its apiOnly entry.
    expect(stale).toEqual([]);
  });
});
