import { describe, expect, it } from "vitest";
import { brand } from "./index.ts";

describe("brand", () => {
  it("keeps the slug a safe lowercase identifier", () => {
    expect(brand.slug).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("derives the npm scope from the slug", () => {
    expect(brand.npmScope).toBe(`@${brand.slug}`);
  });
});
