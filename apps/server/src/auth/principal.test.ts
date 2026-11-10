import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { schema } from "@helpos/db";
import { describe, expect, it } from "vitest";
import { scopes } from "./principal.ts";

// The scope list has one home: `apiTokenScopes` in packages/db/src/schema.ts, which also builds
// the api_tokens CHECK constraint. `scopes` is that list plus the human-only admin scope.

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(here, "../../../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "dist" ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("scopes", () => {
  it("are the agent token scopes plus workspace:admin, which a token can never hold", () => {
    expect([...scopes]).toEqual([...schema.apiTokenScopes, "workspace:admin"]);
    expect(schema.apiTokenScopes).not.toContain("workspace:admin");
  });

  it("are listed in one place: no other source file spells out a whole list", () => {
    // Five quoted `area:action` names in a row is a copy of the list. Smaller runs are a token
    // or a route naming the few scopes it needs, which is fine.
    const copy = /(?:"[a-z]+:[a-z]+",\s*){4}"[a-z]+:[a-z]+"/;
    const home = join(repoRoot, "packages/db/src/schema.ts");
    const copies = ["apps", "packages"]
      .flatMap((dir) => sourceFiles(join(repoRoot, dir)))
      .filter((file) => file !== home && copy.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(repoRoot.length + 1));
    expect(
      copies,
      "derive from apiTokenScopes (packages/db/src/schema.ts) instead of listing scopes again",
    ).toEqual([]);
  });
});
