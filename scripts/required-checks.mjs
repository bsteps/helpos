// Compares .github/required-checks.json with the branch ruleset that GitHub enforces, and fails
// when they differ. Run daily by .github/workflows/required-checks.yml, or locally (needs `gh`
// signed in, or GH_TOKEN) with `node scripts/required-checks.mjs`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The indented block under a top-level `jobs:` key, comments removed. */
function jobsBlock(text) {
  const lines = text.split("\n").filter((line) => !line.trimStart().startsWith("#"));
  const start = lines.indexOf("jobs:");
  if (start === -1) return [];
  const end = lines.findIndex((line, i) => i > start && /^\S/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** Each job of a workflow, keyed by id: its display name, its `needs` and its text. */
export function workflowJobs(text) {
  const texts = {};
  let current;
  for (const line of jobsBlock(text)) {
    const id = /^ {2}([\w-]+):\s*$/.exec(line)?.[1];
    if (id) current = id;
    if (current) texts[current] = `${texts[current] ?? ""}${line}\n`;
  }
  return Object.fromEntries(
    Object.entries(texts).map(([id, jobText]) => {
      const name = /^ {4}name: (.+?)\s*$/m.exec(jobText)?.[1]?.replace(/^(["'])(.*)\1$/, "$2");
      const needs = /^ {4}needs: \[([^\]]*)\]/m.exec(jobText)?.[1] ?? "";
      return [
        id,
        {
          name: name ?? id,
          needs: needs
            .split(",")
            .map((need) => need.trim())
            .filter(Boolean),
          text: jobText,
        },
      ];
    }),
  );
}

/** Every context the branch rules require, sorted, from the rules-for-a-branch API response. */
export function liveContexts(rules) {
  const contexts = rules
    .filter((rule) => rule.type === "required_status_checks")
    .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
    .map((check) => check.context);
  return [...new Set(contexts)].sort();
}

/** What the list requires that GitHub doesn't, and what GitHub requires that the list lacks. */
export function drift(listed, live) {
  return {
    missing: listed.filter((context) => !live.includes(context)),
    extra: live.filter((context) => !listed.includes(context)),
  };
}

function main() {
  const { branch, checks } = JSON.parse(
    readFileSync(new URL("../.github/required-checks.json", import.meta.url), "utf8"),
  );
  const response = execFileSync(
    "gh",
    ["api", `repos/{owner}/{repo}/rules/branches/${branch}?per_page=100`],
    { encoding: "utf8", cwd: fileURLToPath(new URL("../", import.meta.url)) },
  );
  const listed = checks.map((check) => check.context);
  const { missing, extra } = drift(listed, liveContexts(JSON.parse(response)));
  if (missing.length === 0 && extra.length === 0) {
    process.stdout.write(`Required checks match the ${branch} ruleset: ${listed.join(", ")}\n`);
    return;
  }
  for (const context of missing) {
    process.stderr.write(
      `Listed in .github/required-checks.json, not required by GitHub: ${context}\n`,
    );
  }
  for (const context of extra) {
    process.stderr.write(
      `Required by GitHub, not listed in .github/required-checks.json: ${context}\n`,
    );
  }
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
