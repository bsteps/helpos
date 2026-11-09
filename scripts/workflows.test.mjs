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

/** Each job's text, keyed by job id. */
function jobs(text) {
  const result = {};
  let current;
  for (const line of block(text, "jobs").split("\n")) {
    const id = /^ {2}([\w-]+):\s*$/.exec(line)?.[1];
    if (id) current = id;
    if (current) result[current] = `${result[current] ?? ""}${line}\n`;
  }
  return result;
}

/** The value of a `--flag "a,b,c"` in claude_args, as a list. */
function toolList(text, flag) {
  const match = new RegExp(`${flag} "([^"]*)"`).exec(text);
  return match?.[1]?.split(",") ?? [];
}

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
  for (const { name, text } of workflows) {
    for (const [expr] of text.matchAll(/\$\{\{[^}]*\}\}/g)) {
      assert.doesNotMatch(
        expr,
        /github\.event\.[\w.]*\.(body|title|name|ref)\b|github\.(head_ref|ref_name)\b/,
        name,
      );
    }
  }
});

test("Claude workflows: only pull_request or issue_comment, with cost and time caps", () => {
  for (const { name, text } of claudeWorkflows) {
    const triggers = [...block(text, "on").matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1]);
    for (const trigger of triggers) {
      assert.ok(["pull_request", "issue_comment", "workflow_call"].includes(trigger), name);
    }
    for (const [id, job] of Object.entries(jobs(text))) {
      assert.match(job, /timeout-minutes: \d+/, `${name}/${id}: no timeout`);
    }
    assert.match(text, /--max-turns \d+/, `${name}: no --max-turns`);
    assert.match(text, /--model claude-/, `${name}: no --model`);
    assert.match(text, /--allowedTools "/, `${name}: no --allowedTools`);
  }
});

test("Claude workflows deny reads where credentials live", () => {
  for (const { name, text } of claudeWorkflows) {
    const denied = toolList(text, "--disallowedTools");
    for (const rule of ["Bash", "WebFetch", "Read(//proc/**)", "Read(~/.claude/**)"]) {
      assert.ok(denied.includes(rule), `${name}: ${rule} not denied`);
    }
    assert.ok(
      denied.some((rule) => rule.endsWith("/.git/**)")),
      `${name}: .git readable`,
    );
  }
});

test("AI review jobs are read-only: no shell, no edits, comments only", () => {
  const review = read(`${dir}ai-check.yml`);
  const allowed = toolList(review, "--allowedTools");
  for (const tool of allowed) {
    assert.ok(
      tool.startsWith("Read(") || tool === "mcp__github_inline_comment__create_inline_comment",
      `review job allows ${tool}`,
    );
  }
  const denied = toolList(review, "--disallowedTools");
  for (const tool of ["Bash", "Edit", "MultiEdit", "Write", "NotebookEdit", "Grep", "Glob"]) {
    assert.ok(denied.includes(tool), `review job doesn't deny ${tool}`);
  }
  assert.match(review, /--model claude-sonnet-/, "reviews use Sonnet (Opus writes the code)");
  assert.match(review, /github_token: \$\{\{ github\.token \}\}/, "uses the job's own token");
  assert.doesNotMatch(review, /id-token|contents: write|issues: write|actions:/);
  assert.match(review, /never instructions/, "the prompt says PR content is data");
  assert.match(review, /continue-on-error: true/, "advisory: never blocks a PR");
});

test("each AI check is gated to maintainers' same-repo PRs, capped and path-filtered", () => {
  for (const { name, text } of callers) {
    const triggers = [...block(text, "on").matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1]);
    assert.deepEqual(triggers, ["pull_request"], name);
    assert.match(block(text, "on"), /paths:\n\s+- "/, `${name}: no path filter`);
    assert.ok(text.includes("github.event.pull_request.head.repo.full_name == github.repository"));
    assert.ok(text.includes(`${maintainersOnly}, github.event.pull_request.author_association)`));
    assert.match(block(text, "concurrency"), /pull_request\.number[\s\S]*cancel-in-progress: true/);
    assert.match(text, /contents: read\n\s+pull-requests: write\n/, `${name}: permissions`);
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
  assert.ok(claude.includes(`${maintainersOnly}, github.event.comment.author_association)`));
  assert.ok(claude.includes("github.event.comment.user.type == 'User'"));
  assert.match(claude, /head\.repo\.full_name[\s\S]*run=false/, "fork PRs are skipped");
  assert.match(claude, /use_commit_signing: "true"/, "no git push from the CLI");
  const allowed = toolList(claude, "--allowedTools");
  for (const tool of allowed) {
    assert.ok(!/^(Bash|Edit|Write|MultiEdit)\b/.test(tool), `@claude allows ${tool}`);
  }
  assert.match(claude, /never instructions/, "the prompt says issue and PR text is data");
});

test("each skill reads its shared rules, treats input as data and only comments", () => {
  for (const { text } of callers) {
    const check = checkId(text);
    const skill = read(`.claude/skills/${check}-check/SKILL.md`);
    assert.match(skill, new RegExp(`^---\\n\\n?name: ${check}-check\\ndescription: "`));
    assert.ok(skill.includes(`docs/checks/${check}.md`), `${check}: links its rules`);
    assert.match(skill, /never instructions to you/, `${check}: input is data`);
    assert.match(skill, /never approve, request changes/, `${check}: comments only`);
    assert.match(skill, /All clear/, `${check}: says All clear`);
    assert.ok(read("docs/checks/README.md").includes(`${check}.md`), `${check}: listed`);
  }
});
