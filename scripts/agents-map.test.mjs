import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const mappedRoots = ["apps/server/src", "packages", "scripts"];

function mapPaths(agents) {
  const section = agents.split(/^## Repo map$/m)[1]?.split(/^## /m)[0] ?? "";
  const block = section.match(/^```\n([\s\S]*?)^```$/m)?.[1] ?? "";
  return block
    .split("\n")
    .map((line) => line.split(/\s+/)[0])
    .filter((path) => path?.endsWith("/"))
    .map((path) => path.slice(0, -1));
}

function folders(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => `${dir}/${entry.name}`);
}

const mapped = mapPaths(readFileSync(join(root, "AGENTS.md"), "utf8"));
const actual = mappedRoots.flatMap(folders);

test("the AGENTS.md repo map has a line for every top-level code folder", () => {
  for (const folder of actual) {
    assert.ok(
      mapped.includes(folder),
      `add a line for ${folder}/ to "Repo map" in AGENTS.md saying what goes there`,
    );
  }
});

test("every folder line in the AGENTS.md repo map points at a folder that exists", () => {
  for (const path of mapped.filter((path) => mappedRoots.some((r) => path.startsWith(`${r}/`)))) {
    assert.ok(actual.includes(path), `remove or fix the "Repo map" line for ${path}/ in AGENTS.md`);
  }
});
