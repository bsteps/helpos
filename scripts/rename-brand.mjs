#!/usr/bin/env node
// Renames the product everywhere in one go.
//
//   pnpm rename-brand HelpOS NewName           # preview only (default, safe)
//   pnpm rename-brand HelpOS NewName --apply   # actually change files
//
// Replaces the display name (HelpOS), slug (helpos) and env prefix (HELPOS)
// in every git-tracked text file. Never touches legal texts (LICENSE, CLA.md,
// CODE_OF_CONDUCT.md), ADRs, the lockfile, or repository URLs.
// The logic lives in packages/brand/src/rename.ts (unit-tested).
// Always review `git diff` before committing.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isProtectedPath, isValidBrandName, renameText } from "../packages/brand/src/rename.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const [oldName, newName] = args.filter((arg) => !arg.startsWith("--"));

if (!oldName || !newName || !isValidBrandName(newName)) {
  process.stderr.write(
    "Usage: pnpm rename-brand <OldName> <NewName> [--apply]  (letters/digits only)\n",
  );
  process.exit(1);
}

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
let changed = 0;
for (const file of files) {
  if (isProtectedPath(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\u0000")) continue; // binary file
  const next = renameText(text, oldName, newName);
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
