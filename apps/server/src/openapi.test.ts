import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { committedDocumentUrl, formatDocument, openApiDocument } from "./openapi.ts";

describe("the committed API document", () => {
  it("matches what the server serves, so the dashboard's client is up to date", async () => {
    const committed = readFileSync(committedDocumentUrl, "utf8");
    // If this fails: `pnpm --filter @helpos/web gen:api`, then commit the result.
    expect(committed).toBe(formatDocument(await openApiDocument()));
  });
});
