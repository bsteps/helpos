import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const adrDir = join(root, "docs/adr");
const adrFiles = readdirSync(adrDir).filter((name) => /^\d{4}-.+\.md$/.test(name));
const currentIds = new Set(adrFiles.map((name) => name.slice(0, 4)));
const index = readFileSync(join(adrDir, "README.md"), "utf8");

test("ADRs state current decisions without supersession records", () => {
  for (const name of [...adrFiles, "README.md"]) {
    assert.doesNotMatch(
      readFileSync(join(adrDir, name), "utf8"),
      /\bsupersed(?:es|ed|ing)\b|\bhistorical:/i,
      `${name}: update the decision directly and remove obsolete wording; Git keeps its history`,
    );
  }
});

test("the ADR index lists every current decision once", () => {
  const linkedFiles = [...index.matchAll(/\]\((\d{4}-.+?\.md)\)/g)].map((match) => match[1]);
  assert.deepEqual(linkedFiles.toSorted(), adrFiles.toSorted());
});

test("maintained documentation references only current ADRs", () => {
  const docs = readdirSync(join(root, "docs"), { recursive: true })
    .filter((name) => name.endsWith(".md"))
    .map((name) => join("docs", name));
  const paths = [
    ...docs,
    "AGENTS.md",
    "README.md",
    "CONTRIBUTING.md",
    ".claude/skills/verify-helpos/features/knowledge.md",
  ];
  for (const path of paths) {
    for (const [, id] of readFileSync(join(root, path), "utf8").matchAll(/\bADR\s+(\d{4})\b/g)) {
      assert.ok(currentIds.has(id), `${path}: point ADR ${id} at its current decision`);
    }
  }
});
