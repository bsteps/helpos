import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { paths } from "./schema.gen.ts";

const methods = ["get", "post", "put", "patch", "delete"] as const;
type Method = (typeof methods)[number];

type Operation = {
  [P in keyof paths & string]: {
    [M in Method]: paths[P][M] extends undefined ? never : `${Uppercase<M>} ${P}`;
  }[Method];
}[keyof paths & string];

type ApiOnlyReason = { kind: "machine"; caller: string } | { kind: "gap"; issue: number };

const apiOnly: Partial<Record<Operation, ApiOnlyReason>> = {
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
};

function specOperations(): string[] {
  const spec: { paths: Record<string, Record<string, unknown>> } = JSON.parse(
    readFileSync(new URL("./openapi.json", import.meta.url), "utf8"),
  );
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((method) => methods.some((m) => m === method))
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
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "api" &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      calls.add(`${node.expression.name.text} ${node.arguments[0].text}`);
    }
    ts.forEachChild(node, visit);
  };
  for (const file of sourceFiles(fileURLToPath(new URL("..", import.meta.url)))) {
    visit(ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest));
  }
  return calls;
}

describe("dashboard and API parity", () => {
  const calls = dashboardCalls();

  it("calls every API operation from the dashboard, unless it is listed as API-only", () => {
    const missing = specOperations().filter((op) => !calls.has(op) && !(op in apiOnly));
    expect(missing, "add the dashboard screen, or a machine entry in apiOnly").toEqual([]);
  });

  it("lists no API-only operation that the dashboard calls", () => {
    const stale = Object.keys(apiOnly).filter((op) => calls.has(op));
    expect(stale, "delete these apiOnly entries").toEqual([]);
  });
});
