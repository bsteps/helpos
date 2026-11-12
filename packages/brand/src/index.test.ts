import { describe, expect, it } from "vitest";
import { brand, envPrefix } from "./index.ts";

describe("brand", () => {
  it("keeps the slug a safe lowercase identifier", () => {
    expect(brand.slug).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("derives the env prefix from the slug", () => {
    expect(envPrefix).toBe(`${brand.slug.toUpperCase()}_`);
  });
});
