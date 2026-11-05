#!/usr/bin/env node
// Renames the product everywhere in one go.
//
//   pnpm rename-brand HelpOS NewName
//
// Replaces three forms of the name in every git-tracked text file:
//   HelpOS -> NewName   (display name)
//   helpos -> newname   (slug: packages, CLI, Docker images, URLs)
//   HELPOS -> NEWNAME   (env var prefix)
// Then review the diff (`git diff`) before committing.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [oldName, newName] = process.argv.slice(2);
if (!oldName || !newName || !/^[A-Za-z][A-Za-z0-9]*$/.test(newName)) {
  process.stderr.write("Usage: pnpm rename-brand <OldName> <NewName>  (letters/digits only)\n");
  process.exit(1);
}

// Files whose text must never change (legal texts we don't own).
const skip = new Set(["LICENSE", "CODE_OF_CONDUCT.md", "pnpm-lock.yaml"]);

const replacements = [
  [oldName, newName],
  [oldName.toLowerCase(), newName.toLowerCase()],
  [oldName.toUpperCase(), newName.toUpperCase()],
];

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
let changed = 0;
for (const file of files) {
  if (skip.has(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\u0000")) continue; // binary
  let next = text;
  for (const [from, to] of replacements) next = next.split(from).join(to);
  if (next !== text) {
    writeFileSync(file, next);
    changed++;
    process.stdout.write(`updated ${file}\n`);
  }
}
process.stdout.write(
  `\nDone: ${changed} files updated. Run \`pnpm install\` and review \`git diff\`.\n`,
);
