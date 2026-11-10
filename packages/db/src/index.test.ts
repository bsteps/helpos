import { readFileSync } from "node:fs";
import * as drizzle from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as db from "./index.ts";

// The package entry point re-exports drizzle-orm whole and the schema as one namespace, so a
// feature that needs a new operator or schema type never edits index.ts.

describe("the @helpos/db entry point", () => {
  it("re-exports every drizzle-orm export, so no hand-picked list can fall behind", () => {
    const missing = Object.keys(drizzle).filter((name) => !(name in db));
    expect(missing, 'add `export * from "drizzle-orm"` to src/index.ts').toEqual([]);
  });

  it("has no hand-picked drizzle-orm names or schema types", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const fromDrizzle = source.match(/from "drizzle-orm[^"]*"/g) ?? [];
    expect(fromDrizzle, "re-export drizzle-orm with `export *` only").toEqual([
      'from "drizzle-orm"',
    ]);
    expect(source).toMatch(/export \* from "drizzle-orm";/);
    const fromSchema = source.match(/from "\.\/schema\.ts"/g) ?? [];
    expect(fromSchema, "callers use schema.<Type>; don't re-export schema names by hand").toEqual([
      'from "./schema.ts"',
    ]);
    expect(source).toMatch(/export \* as schema from "\.\/schema\.ts";/);
  });
});
