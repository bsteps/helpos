// `pnpm test:scripts`: the required-check list in .github/required-checks.json names real jobs,
// and CI's required gate waits for the jobs that matter. No network: the daily workflow
// .github/workflows/required-checks.yml compares the list with the live ruleset.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { drift, liveContexts, workflowJobs } from "./required-checks.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const { checks } = JSON.parse(read(".github/required-checks.json"));

const ci = workflowJobs(read(".github/workflows/ci.yml"));
const gateJob = checks.find((check) => check.workflow === "ci.yml")?.job ?? "";
const notGated = {
  e2e: "not required today; making it block merges is a separate decision",
  demo: "not required today; making it block merges is a separate decision",
};

test("each listed check is a context with one origin, and no context repeats", () => {
  assert.ok(checks.length > 0, "the list is empty");
  const contexts = new Set();
  for (const check of checks) {
    assert.ok(check.context?.trim(), `entry without a context: ${JSON.stringify(check)}`);
    assert.ok(!contexts.has(check.context), `listed twice: ${check.context}`);
    contexts.add(check.context);
    const inRepo = check.workflow !== undefined || check.job !== undefined;
    const external = check.source !== undefined;
    assert.ok(
      inRepo !== external,
      `${check.context}: give either workflow and job, or source, not both or neither`,
    );
    if (inRepo) {
      assert.ok(check.workflow && check.job, `${check.context}: workflow and job go together`);
    } else {
      assert.ok(check.source.trim(), `${check.context}: source is empty`);
    }
  }
});

test("each repo check is a job with the listed name: renaming one means updating the list", () => {
  for (const check of checks.filter((entry) => entry.workflow)) {
    const path = `.github/workflows/${check.workflow}`;
    assert.ok(existsSync(new URL(path, root)), `${check.context}: ${path} does not exist`);
    const job = workflowJobs(read(path))[check.job];
    assert.ok(job, `${check.context}: ${path} has no job "${check.job}"`);
    assert.equal(
      job.name,
      check.context,
      `${path} job "${check.job}" is named "${job.name}", not "${check.context}". Change the name, .github/required-checks.json and the ruleset together`,
    );
  }
});

test("the CI gate waits for every job except the ones listed as not gated", () => {
  const gate = ci[gateJob];
  assert.ok(gate, `ci.yml has no job "${gateJob}"`);
  const expected = Object.keys(ci)
    .filter((id) => id !== gateJob && !(id in notGated))
    .sort();
  assert.ok(expected.length > 0, "no jobs for the gate to wait for");
  assert.deepEqual([...gate.needs].sort(), expected, "needs must list every gated CI job");
  assert.match(
    gate.text,
    /^ {4}if: \$\{\{ always\(\) && !github\.event\.pull_request\.draft \}\}$/m,
    "a skipped required check counts as passing, so the gate must run after a cancelled job",
  );
  assert.match(
    gate.text,
    /RESULTS: \$\{\{ join\(needs\.\*\.result, ' '\) \}\}/,
    "joins every result",
  );
  assert.match(
    gate.text,
    /for result in \$RESULTS; do test "\$result" = success; done/,
    "tests each result is success",
  );
});

test("liveContexts flattens every required_status_checks rule, sorted and unique", () => {
  const rules = [
    { type: "deletion" },
    {
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "b" }, { context: "a" }] },
    },
    { type: "pull_request", parameters: {} },
    {
      type: "required_status_checks",
      parameters: {
        required_status_checks: [{ context: "c", integration_id: 1 }, { context: "a" }],
      },
    },
  ];
  assert.deepEqual(liveContexts(rules), ["a", "b", "c"]);
  assert.deepEqual(liveContexts([{ type: "deletion" }, { type: "non_fast_forward" }]), []);
});

test("drift reports what each side lacks", () => {
  assert.deepEqual(drift(["a", "b"], ["b", "c"]), { missing: ["a"], extra: ["c"] });
  assert.deepEqual(drift(["a"], ["a"]), { missing: [], extra: [] });
});

test("workflowJobs reads names, needs and ignores comments", () => {
  const jobs = workflowJobs(
    [
      "name: X",
      "jobs:",
      "  # job: commented",
      "  build:",
      '    name: "Build it"',
      "  gate:",
      "    needs: [build, lint]",
      "    # name: commented",
      "  lint:",
      "    runs-on: x",
      "other:",
      "  not-a-job:",
    ].join("\n"),
  );
  assert.deepEqual(Object.keys(jobs), ["build", "gate", "lint"]);
  assert.equal(jobs.build?.name, "Build it");
  assert.equal(jobs.lint?.name, "lint");
  assert.deepEqual(jobs.gate?.needs, ["build", "lint"]);
  assert.deepEqual(jobs.build?.needs, []);
});
