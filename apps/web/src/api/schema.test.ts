import { readFileSync } from "node:fs";
import openapiTS, { astToString } from "openapi-typescript";
import { describe, expect, it } from "vitest";

describe("the generated API client types", () => {
  it("match the committed OpenAPI document", async () => {
    const spec = new URL("./openapi.json", import.meta.url);
    const expected = astToString(await openapiTS(spec));
    const committed = readFileSync(new URL("./schema.gen.ts", import.meta.url), "utf8");
    // If this fails: `pnpm --filter @helpos/web gen:api`, then commit the result.
    expect(committed.slice(committed.indexOf("export"))).toBe(
      expected.slice(expected.indexOf("export")),
    );
  });
});
