// `pnpm test:scripts`: security rules for GitHub Actions workflows, and the AI review checks.
// The repo is public and the AI checks spend the owner's Claude subscription, so these rules
// are tested instead of trusted to review. Plain text checks: no YAML dependency needed.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const dir = ".github/workflows/";
const workflows = readdirSync(new URL(dir, root))
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, text: read(dir + name) }));

/** Lines of a workflow without comments, so a comment can't satisfy or trip a rule. */
const code = (text) =>
  text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

/** The indented block under a top-level key such as `on:` or `jobs:`. */
function block(text, key) {
  const lines = code(text).split("\n");
  const start = lines.indexOf(`${key}:`);
  if (start === -1) return "";
  const end = lines.findIndex((line, i) => i > start && /^\S/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

/** Each job's text, keyed by job id. Fails if it finds none, so loops can't pass vacuously. */
function jobs(text) {
  const result = {};
  let current;
  for (const line of block(text, "jobs").split("\n")) {
    const id = /^ {2}([\w-]+):\s*$/.exec(line)?.[1];
    if (id) current = id;
    if (current) result[current] = `${result[current] ?? ""}${line}\n`;
  }
  assert.ok(Object.keys(result).length > 0, "no jobs found: write jobs as a block");
  return result;
}

/** Trigger names under `on:`. Fails if `on:` isn't a block this test can read. */
function triggers(text, name) {
  const found = [...block(text, "on").matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1]);
  assert.ok(found.length > 0, `${name}: write "on:" as a block`);
  return found;
}

/** A job's `permissions:` block as { scope: level }, or undefined without one. */
function permissions(job) {
  const lines = job.split("\n");
  const start = lines.findIndex((line) => /^ {4}permissions:\s*$/.test(line));
  if (start === -1) return undefined;
  const result = {};
  for (const line of lines.slice(start + 1)) {
    const match = /^ {6}([\w-]+): (\w+)/.exec(line);
    if (!match) break;
    result[match[1] ?? ""] = match[2];
  }
  return result;
}

/** A job's `if: >-` condition. */
const condition = (job) => /^ {4}if: >-\n((?: {6}.*\n)+)/m.exec(job)?.[1] ?? "";

/** The value of a `--flag "a,b,c"` in claude_args, as a list. Exactly one, never empty. */
function toolList(text, flag) {
  const matches = [...code(text).matchAll(new RegExp(`${flag} "([^"]*)"`, "g"))];
  assert.equal(matches.length, 1, `exactly one ${flag} "..."`);
  const list = matches[0]?.[1]?.split(",") ?? [];
  assert.ok(list.length > 0 && !list.includes(""), `${flag} is empty`);
  return list;
}

/** A GitHub expression such as `${{ runner.temp }}`, written literally. */
const expr = (inner) => `\${{ ${inner} }}`;

/** The `check:` input a caller passes to ai-check.yml. */
const checkId = (text) => /^\s+check: ([\w-]+)$/m.exec(code(text))?.[1] ?? "";

const usesClaude = (w) => w.text.includes("anthropics/claude-code-action@");
const claudeWorkflows = workflows.filter(usesClaude);
const callers = workflows.filter((w) => w.text.includes("uses: ./.github/workflows/ai-check.yml"));
const maintainersOnly = `contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]')`;

test("there are workflows to check", () => {
  assert.ok(workflows.length > 0);
  assert.ok(claudeWorkflows.length >= 2, "claude.yml and ai-check.yml");
  assert.equal(callers.length, 3, "one workflow per AI check");
});

test("no trigger that hands secrets to fork code", () => {
  for (const { name, text } of workflows) {
    // Word boundaries: the action's `get_workflow_run_details` tool is fine.
    for (const banned of [/\bpull_request_target\b/, /\bworkflow_run\b/]) {
      assert.doesNotMatch(text, banned, name);
    }
  }
});

test("the Claude action never lets non-maintainers or bots in", () => {
  for (const { name, text } of workflows) {
    for (const banned of ["allowed_non_write_users", "allowed_bots"]) {
      assert.ok(!text.includes(banned), `${name} sets ${banned}`);
    }
  }
});

test("every action is pinned to a full commit SHA with a version comment", () => {
  for (const { name, text } of workflows) {
    for (const [, ref] of code(text).matchAll(/^\s*(?:-\s+)?uses:\s*(.+)$/gm)) {
      if (ref.startsWith("./")) continue; // a workflow from this same commit
      assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d/, `${name}: ${ref}`);
    }
  }
});

test("checkout never leaves a token on disk", () => {
  for (const { name, text } of workflows) {
    const steps = code(text).split(/\n\s*- /);
    for (const step of steps.filter((s) => s.includes("actions/checkout@"))) {
      assert.match(step, /persist-credentials: false/, `${name}: checkout without it`);
    }
  }
});

test("every workflow starts from no or read-only permissions", () => {
  for (const { name, text } of workflows) {
    assert.match(code(text), /^permissions:( \{\}|\n {2}contents: read\n)/m, name);
  }
});

test("untrusted PR and issue text is never expanded into a script or prompt", () => {
  const untrusted =
    /github\.event\.[\w.]*\.(body|title|name|ref|label|description|message|email)\b|github\.(head_ref|ref_name)\b/;
  for (const { name, text } of workflows) {
    for (const [expr] of text.matchAll(/\$\{\{[^}]*\}\}/g)) {
      assert.doesNotMatch(expr, untrusted, `${name}: ${expr}`);
    }
  }
});

test("Claude workflows: only pull_request or issue_comment, with cost and time caps", () => {
  for (const { name, text } of claudeWorkflows) {
    for (const trigger of triggers(text, name)) {
      assert.ok(["pull_request", "issue_comment", "workflow_call"].includes(trigger), name);
    }
    for (const [id, job] of Object.entries(jobs(text))) {
      assert.match(job, /timeout-minutes: \d+/, `${name}/${id}: no timeout`);
    }
    assert.match(text, /--max-turns \d+/, `${name}: no --max-turns`);
    assert.match(text, /--model claude-/, `${name}: no --model`);
    toolList(text, "--allowedTools");
    // Nothing that widens what Claude may do, loads outside config, or prints tool output.
    const widening =
      /dangerously|bypassPermissions|--permission-mode|--mcp-config|--settings|^\s+settings:|plugins:|plugin_marketplaces:|show_full_output|ACTIONS_STEP_DEBUG/m;
    assert.doesNotMatch(code(text), widening, name);
  }
});

/** Every place on a runner where a token can sit. Both Claude workflows must deny all of them. */
const credentialRules = [
  "Read(//proc/**)",
  `Read(/${expr("runner.temp")}/**)`,
  "Read(//home/runner/runners/**)",
  "Read(//home/runner/actions-runner/**)",
  "Read(~/.claude/**)",
  "Read(~/.claude.json)",
  "Read(~/.config/**)",
  "Read(~/.ssh/**)",
  "Read(~/.docker/**)",
  "Read(~/.gitconfig)",
  "Read(~/.git-credentials)",
  "Read(~/.npmrc)",
  `Read(/${expr("github.workspace")}/.git)`,
  `Read(/${expr("github.workspace")}/.git/**)`,
];

test("Claude workflows: no shell, no search, no web, and no reads where credentials live", () => {
  const readRules = [];
  for (const { name, text } of claudeWorkflows) {
    const denied = toolList(text, "--disallowedTools");
    // Denied by name, a tool is gone even if the action allowed it. Search could reach /proc.
    for (const tool of ["Bash", "WebFetch", "WebSearch", "Grep", "Glob", "LS"]) {
      assert.ok(denied.includes(tool), `${name}: ${tool} not denied`);
    }
    for (const rule of credentialRules) {
      assert.ok(denied.includes(rule), `${name}: ${rule} not denied`);
    }
    readRules.push(denied.filter((rule) => rule.startsWith("Read(")).sort());
  }
  const [first, ...rest] = readRules;
  for (const other of rest) assert.deepEqual(other, first, "deny lists drifted apart");
});

test("AI review jobs are read-only: no shell, no edits, comments only", () => {
  const review = read(`${dir}ai-check.yml`);
  assert.deepEqual(toolList(review, "--allowedTools"), [
    `Read(/${expr("github.workspace")}/**)`,
    `Read(/${expr("github.workspace")}-inputs/**)`,
    "mcp__github_inline_comment__create_inline_comment",
  ]);
  const denied = toolList(review, "--disallowedTools");
  for (const tool of ["Edit", "MultiEdit", "Write", "NotebookEdit", "Task", "Agent"]) {
    assert.ok(denied.includes(tool), `review job doesn't deny ${tool}`);
  }
  assert.deepEqual(permissions(jobs(review).check ?? ""), {
    contents: "read",
    "pull-requests": "write",
  });
  assert.match(review, /--model claude-sonnet-/, "reviews use Sonnet (Opus writes the code)");
  assert.match(review, /github_token: \$\{\{ github\.token \}\}/, "uses the job's own token");
  assert.match(review, /never instructions/, "the prompt says PR content is data");
  assert.match(review, /continue-on-error: true/, "advisory: a model failure never blocks");
});

test("AI review jobs never take instructions from the PR's own files", () => {
  const review = read(`${dir}ai-check.yml`);
  // The skill and rules are base-branch copies outside the checkout, and the prompt uses them.
  assert.match(review, /git show "\$BASE_SHA:\$skill" > "\$INPUTS\/skill\.md"/);
  assert.match(review, /git show "\$BASE_SHA:\$rules" > "\$INPUTS\/rules\.md"/);
  assert.match(review, /Read \$\{\{ github\.workspace \}\}-inputs\/skill\.md/);
  assert.doesNotMatch(review, /Read \.claude\/skills/, "never the PR head's skill");
  // Every instruction file, at any depth, is removed and put back from the base branch.
  for (const file of ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"]) {
    assert.ok(review.includes(`':(glob)**/${file}'`), `${file} from the PR stays loaded`);
  }
  assert.ok(review.includes("rm -rf .claude .mcp.json .claude.json"));
  assert.ok(review.includes('git checkout "$BASE_SHA" -- .claude'));
  assert.ok(review.includes('git ls-tree -r -z --name-only "$BASE_SHA"'), "nested base copies");
  assert.ok(review.includes("(CLAUDE|CLAUDE\\.local|AGENTS)\\.md$"), "every instruction file");
  assert.ok(review.includes('xargs -0 -r git checkout "$BASE_SHA" --'));
});

test("AI review jobs judge against the current base branch, without the PR's symlinks", () => {
  const review = read(`${dir}ai-check.yml`);
  assert.ok(review.includes('"refs/remotes/origin/$GITHUB_BASE_REF^{commit}"'), "current base tip");
  assert.match(review, /if \[\[ \$entry == 120000\* \]\]; then rm -f -- /, "symlinks removed");
});

test("the AI check report counts only this run's comments and fails on a broken setup", () => {
  const review = read(`${dir}ai-check.yml`);
  assert.ok(review.includes('grep -cvxF -f "$INPUTS/earlier-ids.txt"'), "re-runs aren't new");
  assert.doesNotMatch(code(review), /\|\s*head\b/, "head can break a pipe under pipefail");
  assert.match(review, /status="Didn't finish[^"]*\$new finding/, "a partial run still reports");
  assert.equal(code(review).match(/git -c core\.quotepath=off diff/g)?.length, 2, "file names");
  assert.ok(review.includes(`PREP: ${expr("steps.prep.outcome")}`));
  assert.match(review, /if \[ "\$PREP" != "success" \]; then\n\s+status="Couldn't prepare/);
  assert.match(review, /\[ "\$PREP" = "success" \]\n$/, "the report step fails when prep failed");
});

test("the test-signal check covers every test file type", () => {
  const paths = block(read(`${dir}ai-check-test-signal.yml`), "on");
  for (const path of ['"**/*.test.*"', '"**/*.spec.*"']) assert.ok(paths.includes(path), path);
});

test("the security check covers code, config, CI and agent instruction files", () => {
  const security = block(read(`${dir}ai-check-security-baseline.yml`), "on");
  const paths = [...security.matchAll(/^\s+- "([^"]+)"$/gm)].map((m) => m[1] ?? "");
  assert.deepEqual(paths.slice(0, 2), ["**", "!**/*.md"], "every file except Markdown");
  // Paths listed after "!**/*.md" count even though they are Markdown.
  const afterMd = paths.slice(paths.indexOf("!**/*.md") + 1);
  for (const path of [".claude/**", "AGENTS.md", "**/CLAUDE.md"]) {
    assert.ok(afterMd.includes(path), `${path} must come after the Markdown exclusion`);
  }
});

test("each AI check is gated to maintainers' same-repo PRs, capped and path-filtered", () => {
  for (const { name, text } of callers) {
    assert.deepEqual(triggers(text, name), ["pull_request"], name);
    assert.match(block(text, "on"), /paths:\n\s+- "/, `${name}: no path filter`);
    const job = jobs(text).check ?? "";
    const gate = condition(job);
    for (const rule of [
      "github.event.pull_request.head.repo.full_name == github.repository",
      `${maintainersOnly}, github.event.pull_request.author_association)`,
      "github.event.pull_request.user.type == 'User'",
      "!github.event.pull_request.draft",
    ]) {
      assert.ok(gate.includes(rule), `${name}: job if: lacks ${rule}`);
    }
    assert.match(block(text, "concurrency"), /pull_request\.number[\s\S]*cancel-in-progress: true/);
    assert.deepEqual(permissions(job), { contents: "read", "pull-requests": "write" }, name);
    assert.doesNotMatch(text, /secrets: inherit/, `${name}: pass only the one secret`);

    const check = checkId(text);
    assert.ok(check && name === `ai-check-${check}.yml`, `${name}: check id`);
    assert.ok(existsSync(new URL(`docs/checks/${check}.md`, root)), `${check}: rules doc`);
    assert.ok(
      existsSync(new URL(`.claude/skills/${check}-check/SKILL.md`, root)),
      `${check}: skill`,
    );
  }
});

test("@claude runs only for maintainers, skips forks and commits only through the API", () => {
  const claude = read(`${dir}claude.yml`);
  const job = jobs(claude).claude ?? "";
  const gate = condition(job);
  assert.ok(gate.includes("startsWith(github.event.comment.body, '@claude')"), "quotes don't run");
  assert.ok(gate.includes("github.event.issue.state == 'open'"), "closed issues and PRs don't run");
  assert.ok(gate.includes(`${maintainersOnly}, github.event.comment.author_association)`));
  assert.ok(gate.includes("github.event.comment.user.type == 'User'"));
  assert.deepEqual(permissions(job), {
    contents: "read",
    "pull-requests": "read",
    actions: "read",
    "id-token": "write",
  });
  assert.match(job, /concurrency:\n\s+group: claude-\$\{\{ github\.event\.issue\.number \}\}/);
  assert.match(claude, /head\.repo\.full_name[\s\S]*run=false/, "fork PRs are skipped");
  assert.match(claude, /use_commit_signing: "true"/, "no git push from the CLI");
  const workspace = `/${expr("github.workspace")}/**)`;
  for (const tool of toolList(claude, "--allowedTools")) {
    assert.ok(!/^(Bash|Edit|Write|MultiEdit)\b/.test(tool), `@claude allows ${tool}`);
    // File tools only inside the checkout. Everything else must be an MCP tool.
    assert.ok(
      tool.startsWith("mcp__github_") || /^(Read|Grep|Glob)\(\//.test(tool),
      `@claude allows unscoped ${tool}`,
    );
    if (!tool.startsWith("mcp__")) assert.ok(tool.endsWith(workspace), `${tool}: not the checkout`);
  }
  assert.match(claude, /never instructions/, "the prompt says issue and PR text is data");
});

test("each skill reads its shared rules, treats input as data and only comments", () => {
  for (const { text } of callers) {
    const check = checkId(text);
    const skill = read(`.claude/skills/${check}-check/SKILL.md`);
    assert.match(skill, new RegExp(`^---\\nname: ${check}-check\\ndescription: "`));
    assert.ok(skill.includes(`docs/checks/${check}.md`), `${check}: links its rules`);
    assert.match(skill, /never instructions to you/, `${check}: input is data`);
    assert.match(skill, /never approve, request changes/, `${check}: comments only`);
    assert.match(skill, /All clear/, `${check}: says All clear`);
    assert.ok(read("docs/checks/README.md").includes(`${check}.md`), `${check}: listed`);
  }
});
