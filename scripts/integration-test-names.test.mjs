import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const dbTesting = join(root, "packages/db/src/testing.ts");

function importsDatabaseTesting(path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest);
  let found = false;
  function visit(node) {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) && node.expression.text === "require"))
          ? node.arguments[0]
          : undefined;
    if (specifier && ts.isStringLiteralLike(specifier)) {
      found ||=
        specifier.text === "@helpos/db/testing" ||
        (specifier.text.startsWith(".") && resolve(dirname(path), specifier.text) === dbTesting);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

test("detects database test-helper imports, including local, dynamic and type imports", () => {
  const serverTest = join(root, "apps/server/src/example.test.ts");
  for (const source of [
    'import { startTestDatabase } from "@helpos/db/testing";',
    "import type { TestDatabase } from '@helpos/db/testing';",
    'import "@helpos/db/testing";',
    'const db = await import("@helpos/db/testing");',
    'const db = require("@helpos/db/testing");',
    'export { startTestDatabase } from "@helpos/db/testing";',
    'import { startTestDatabase } from "../../../packages/db/src/testing.ts";',
  ]) {
    assert.ok(importsDatabaseTesting(serverTest, source), source);
  }
  assert.ok(
    importsDatabaseTesting(
      join(root, "packages/db/src/example.test.ts"),
      'import { startTestDatabase } from "./testing.ts";',
    ),
  );
});

test("ignores other helpers and import text in strings or comments", () => {
  const path = join(root, "apps/server/src/example.test.ts");
  for (const source of [
    'import { mockModel } from "@helpos/ai/testing";',
    'import { seedUsage } from "./testing.ts";',
    '// import { startTestDatabase } from "@helpos/db/testing";',
    '`import { startTestDatabase } from "@helpos/db/testing";`;',
  ]) {
    assert.ok(!importsDatabaseTesting(path, source), source);
  }
});

test("tests importing the database helper are named *.int.test.ts", () => {
  const testFiles = ["apps", "packages"].flatMap((dir) =>
    readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".test.ts") &&
          !relative(root, entry.parentPath).split(/[\\/]/).includes("node_modules"),
      )
      .map((entry) => join(entry.parentPath, entry.name)),
  );
  assert.ok(testFiles.length > 50, "expected tests under apps/ and packages/");
  const wrongNames = testFiles.filter(
    (path) =>
      !path.endsWith(".int.test.ts") && importsDatabaseTesting(path, readFileSync(path, "utf8")),
  );
  assert.deepEqual(
    wrongNames.map((path) => relative(root, path)),
    [],
    "Rename database tests to *.int.test.ts so the unit project runs without Docker.",
  );
});
