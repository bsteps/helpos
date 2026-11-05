#!/usr/bin/env node
// Renames the product everywhere in one go.
//
//   pnpm rename-brand HelpOS NewName           # preview only (default, safe)
//   pnpm rename-brand HelpOS NewName --apply   # actually change files
//
// Replaces three forms of the name in every git-tracked text file:
//   HelpOS -> NewName   (display name)
//   helpos -> newname   (slug: packages, CLI, Docker images)
//   HELPOS -> NEWNAME   (env var prefix)
//
// Repository URLs (github.com/<owner>/<repo>) are left alone: rename the
// GitHub repo first, then update those URLs in a separate commit.
// Always review `git diff` before committing.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const [oldName, newName] = args.filter((arg) => !arg.startsWith("--"));

if (!oldName || !newName || !/^[A-Za-z][A-Za-z0-9]*$/.test(newName)) {
  process.stderr.write(
    "Usage: pnpm rename-brand <OldName> <NewName> [--apply]  (letters/digits only)\n",
  );
  process.exit(1);
}

// Files whose text must never change (legal texts we don't own, generated files).
const skip = new Set(["LICENSE", "CODE_OF_CONDUCT.md", "pnpm-lock.yaml"]);

const replacements = [
  [oldName, newName],
  [oldName.toLowerCase(), newName.toLowerCase()],
  [oldName.toUpperCase(), newName.toUpperCase()],
];

const REPO_URL = /github\.com\/[\w.-]+\/[\w.-]+/g;

/** Rename the brand in `text`, leaving repository URLs untouched. */
function renameText(text) {
  const urls = [];
  let next = text.replace(REPO_URL, (url) => `⟦URL${urls.push(url) - 1}⟧`);
  for (const [from, to] of replacements) next = next.split(from).join(to);
  return next.replace(/⟦URL(\d+)⟧/g, (_, index) => urls[Number(index)]);
}

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
  if (text.includes("\u0000")) continue; // binary file
  const next = renameText(text);
  if (next === text) continue;
  if (apply) writeFileSync(file, next);
  changed++;
  process.stdout.write(`${apply ? "updated" : "would update"} ${file}\n`);
}

process.stdout.write(
  apply
    ? `\nDone: ${changed} files updated. Run \`pnpm install\` and review \`git diff\`.\n`
    : `\nPreview: ${changed} files would change. Nothing was written. Re-run with --apply.\n`,
);
