// Decides what `pnpm check:changed` runs for a list of changed paths.
// Pure (no git, no processes) so the rules are easy to test and to reuse in CI later.

/** @typedef {"none" | "affected" | "all"} Scope */
/** @typedef {{ lintFiles: string[], scope: Scope, evals: boolean, knip: boolean }} Decision */

// Files that can't change what TypeScript or a test sees.
const docOnly = [/\.md$/i, /^docs\//, /^LICENSE$/, /^NOTICE$/, /^\.github\/ISSUE_TEMPLATE\//];

// Root config and shared test setup: a change here can break any package, so check them all.
const runsEverything = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^turbo\.json$/,
  /^tsconfig[^/]*\.json$/,
  /^biome\.json$/,
  /^knip\.jsonc$/,
  /^\.nvmrc$/,
  /^scripts\//,
  /^fixtures\//,
  /(^|\/)vitest\.config\.[cm]?[jt]s$/,
  /(^|\/)tsconfig[^/]*\.json$/,
];

// Prompts, eval cases and the code that builds them. Test files alone don't change model behaviour.
const aiSource = /^packages\/ai\/(src|evals)\//;
const testFile = /\.test\.[cm]?[jt]sx?$/;

const inWorkspace = /^(apps|packages)\/[^/]+\//;

/**
 * @param {readonly string[]} changed paths relative to the repo root, using forward slashes
 * @returns {Decision}
 */
export function decide(changed) {
  const files = [...new Set(changed.map((f) => f.replaceAll("\\", "/")))].filter(Boolean);
  const code = files.filter((f) => !docOnly.some((re) => re.test(f)));

  /** @type {Scope} */
  let scope = "none";
  if (code.some((f) => runsEverything.some((re) => re.test(f)))) scope = "all";
  else if (code.some((f) => inWorkspace.test(f))) scope = "affected";

  const evals = scope === "all" || code.some((f) => aiSource.test(f) && !testFile.test(f));

  // Doc files are nothing Biome checks, so the lint list uses the same rule as the rest.
  // Knip looks at the whole repo, but in seconds: any code change can leave an export unused.
  return { lintFiles: code, scope, evals, knip: code.length > 0 };
}
