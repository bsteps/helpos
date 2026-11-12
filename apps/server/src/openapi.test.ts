import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { errorCodes } from "./http/error-codes.ts";
import { committedDocumentUrl, formatDocument, openApiDocument } from "./openapi.ts";

const catalogSchema = z.object({
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
});
const operationSchema = z.object({ operationId: z.string().trim().min(1) });
const methods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

describe.each([
  ["served", openApiDocument],
  ["committed", async () => JSON.parse(readFileSync(committedDocumentUrl, "utf8"))],
] as const)("the %s API operation catalog", (_name, document) => {
  it("gives every documented operation a nonempty, unique operationId", async () => {
    const catalog = catalogSchema.parse(await document());
    const ids = new Map<string, string>();
    for (const [path, item] of Object.entries(catalog.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!methods.has(method)) continue;
        const name = `${method.toUpperCase()} ${path}`;
        const parsed = operationSchema.safeParse(operation);
        expect(parsed.success, `${name}: missing or empty operationId`).toBe(true);
        if (!parsed.success) continue;
        const { operationId } = parsed.data;
        expect(
          ids.has(operationId),
          `${name}: duplicate operationId ${operationId}, already used by ${ids.get(operationId)}`,
        ).toBe(false);
        ids.set(operationId, name);
      }
    }
    expect(ids.size).toBeGreaterThan(0);
  });
});

describe("the committed API document", () => {
  it("publishes typed error codes including responses with extensions", async () => {
    const error = { type: "string", enum: [...errorCodes] };
    expect(await openApiDocument()).toMatchObject({
      components: {
        schemas: {
          Error: { properties: { error } },
          KnowledgeSourceConflict: {
            properties: { error, sourceId: { type: "string", format: "uuid" } },
          },
          KnowledgeSource: { properties: { error: { type: ["string", "null"] } } },
        },
      },
      paths: {
        "/v1/conversations/{id}/github-issue": {
          post: {
            responses: {
              "500": {
                content: {
                  "application/problem+json": {
                    schema: {
                      properties: { error, url: { type: "string" } },
                      required: ["error", "url"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  });
  it("matches what the server serves, so the dashboard's client is up to date", async () => {
    const committed = readFileSync(committedDocumentUrl, "utf8");
    // If this fails: `pnpm --filter @helpos/web gen:api`, then commit the result.
    expect(committed).toBe(formatDocument(await openApiDocument()));
  });
});
