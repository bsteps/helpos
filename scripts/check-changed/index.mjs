// `pnpm check:changed [base-ref]`: a fast check of only what changed, for iterating.
// Lints the changed files, then typechecks and tests the changed packages plus their
// dependents (Turbo's `...[base]` filter), then runs evals if AI prompts changed.
// CI and `pnpm verify` still run everything.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { decide } from "./decide.mjs";

const git = (/** @type {string[]} */ ...args) => {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
};
const lines = (/** @type {string} */ s) => (s ? s.split("\n") : []);

// pnpm sets npm_execpath to itself: a JS entry (run it with Node) or a standalone binary.
// Calling it directly skips Windows' pnpm.cmd shim, which only starts through a shell.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: set by pnpm for this script, not read by any Turbo task
const pnpmPath = process.env.npm_execpath ?? "";
if (!pnpmPath) throw new Error("Run this through pnpm: pnpm check:changed");
/** @returns {[string, string[]]} */
const pnpm = (/** @type {string[]} */ args) =>
  /\.[cm]?js$/.test(pnpmPath) ? [process.execPath, [pnpmPath, ...args]] : [pnpmPath, args];

const target = process.argv[2] ?? "origin/main";
const found = spawnSync("git", ["rev-parse", "--verify", "--quiet", target], { encoding: "utf8" });
if (found.status !== 0) {
  process.stderr.write(
    `check:changed: no ref "${target}". Run \`git fetch origin\` or pass a base ref.\n`,
  );
  process.exit(1);
}
const base = git("merge-base", "HEAD", target);

// Committed since the base, plus uncommitted and untracked work.
const changed = [
  ...lines(git("diff", "--name-only", base)),
  ...lines(git("ls-files", "--others", "--exclude-standard")),
];
const { lintFiles, scope, evals } = decide(changed);
const present = lintFiles.filter((f) => existsSync(f));

process.stdout.write(
  `check:changed vs ${target} (${base.slice(0, 7)}): ${changed.length} changed, ${lintFiles.length} to lint, ` +
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
      "--",
      ...present,
    ],
  ]);
}
if (scope === "all") {
  steps.push(["pnpm", ["exec", "turbo", "run", "typecheck", "test"]]);
  // List the test files here: with no shell, nothing would expand a glob on older Node versions.
  const scriptTests = readdirSync("scripts", { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".test.mjs"))
    .map((f) => `scripts/${f.replaceAll("\\", "/")}`);
  steps.push(["node", ["--test", ...scriptTests]]);
} else if (scope === "affected") {
  steps.push(["pnpm", ["exec", "turbo", "run", "typecheck", "test", `--filter=...[${base}]`]]);
}
if (evals) steps.push(["pnpm", ["eval"]]);

for (const [cmd, args] of steps) {
  process.stdout.write(`\n> ${cmd} ${args.join(" ")}\n`);
  // Never through a shell: changed paths come from the branch and may hold shell metacharacters.
  const [bin, binArgs] = cmd === "pnpm" ? pnpm(args) : [process.execPath, args];
  const r = spawnSync(bin, binArgs, { stdio: "inherit", shell: false });
  if (r.error) process.stderr.write(`check:changed: could not start ${bin}: ${r.error.message}\n`);
  if (r.signal)
    process.stderr.write(`check:changed: ${cmd} was stopped by ${r.signal}
`);
  if (r.status !== 0) process.exit(r.status ?? 1);
}
process.stdout.write("\ncheck:changed passed. Run `pnpm verify` once before opening a PR.\n");
