// `pnpm check:changed [base-ref]`: a fast check of only what changed, for iterating.
// Lints the changed files, then typechecks and tests the changed packages plus their
// dependents (Turbo's `...[base]` filter), then runs evals if AI prompts changed.
// CI and `pnpm verify` still run everything.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { decide } from "./decide.mjs";

const git = (/** @type {string[]} */ ...args) => {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
};
const lines = (/** @type {string} */ s) => (s ? s.split("\n") : []);

const target = process.argv[2] ?? "origin/main";
const base = git("merge-base", "HEAD", target);

// Committed since the base, plus uncommitted and untracked work.
const changed = [
  ...lines(git("diff", "--name-only", base)),
  ...lines(git("ls-files", "--others", "--exclude-standard")),
];
const { lintFiles, scope, evals } = decide(changed);
const present = lintFiles.filter((f) => existsSync(f));

process.stdout.write(
  `check:changed vs ${target} (${base.slice(0, 7)}): ${lintFiles.length} files, ` +
    `typecheck+test: ${scope}, evals: ${evals ? "yes" : "no"}\n`,
);

/** @type {[string, string[]][]} */
const steps = [];
if (present.length > 0) {
  steps.push([
    "pnpm",
    [
      "exec",
      "biome",
      "check",
      "--no-errors-on-unmatched",
      "--files-ignore-unknown=true",
      ...present,
    ],
  ]);
}
if (scope === "all") {
  steps.push(["pnpm", ["exec", "turbo", "run", "typecheck", "test"]]);
  steps.push(["node", ["--test", "scripts/**/*.test.mjs"]]);
} else if (scope === "affected") {
  steps.push(["pnpm", ["exec", "turbo", "run", "typecheck", "test", `--filter=...[${base}]`]]);
}
if (evals) steps.push(["pnpm", ["eval"]]);

for (const [cmd, args] of steps) {
  process.stdout.write(`\n> ${cmd} ${args.join(" ")}\n`);
  // shell is needed on Windows to find pnpm.cmd; arguments are paths from git, not user text.
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
process.stdout.write("\ncheck:changed passed. Run `pnpm verify` once before opening a PR.\n");
