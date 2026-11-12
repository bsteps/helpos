import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { errorCodes } from "./http/error-codes.ts";
import { committedDocumentUrl, formatDocument, openApiDocument } from "./openapi.ts";

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
