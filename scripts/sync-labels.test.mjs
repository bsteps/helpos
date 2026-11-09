// `pnpm test:scripts`: the managed label list and the sync plan.
import assert from "node:assert/strict";
import { test } from "node:test";
import { issueStates, loadLabels, planSync, prStates, validateLabels } from "./sync-labels.mjs";

const labels = loadLabels();

test("the label list is valid and has every state label", () => {
  assert.deepEqual(validateLabels(labels), []);
});

test("labels the team already relies on stay managed", () => {
  const names = labels.map((l) => l.name);
  for (const name of ["ready", "human-only", "security", "area:ci", "area:gtm"])
    assert.ok(names.includes(name), `${name} is missing`);
});

test("issue and PR states don't share names", () => {
  assert.deepEqual(
    issueStates.filter((s) => prStates.includes(s)),
    [],
  );
});

test("validation catches duplicates, bad colours, empty descriptions and missing states", () => {
  const problems = validateLabels([
    { name: "x", color: "fff", description: "a" },
    { name: "X", color: "FFFFFF", description: "" },
  ]);
  assert.ok(problems.some((p) => p.startsWith("duplicate")));
  assert.ok(problems.some((p) => p.includes("colour")));
  assert.ok(problems.some((p) => p.includes("description")));
  assert.ok(problems.includes("missing state label: needs-human"));
});

test("sync creates missing labels, updates changed ones and leaves others alone", () => {
  const desired = [
    { name: "ready", color: "0E8A16", description: "Ready" },
    { name: "land", color: "5319E7", description: "Merge it" },
    { name: "needs-human", color: "D93F0B", description: "Human queue" },
  ];
  const existing = [
    { name: "ready", color: "0e8a16", description: "Ready" }, // same; GitHub returns lower-case colours
    { name: "Needs-Human", color: "D93F0B", description: "Human queue" }, // wrong case
    { name: "bug", color: "d73a4a", description: "Broken" }, // unmanaged
  ];
  assert.deepEqual(planSync(existing, desired), [
    { action: "create", label: desired[1] },
    { action: "update", from: "Needs-Human", label: desired[2] },
  ]);
});

test("a changed description or colour is an update", () => {
  const desired = [{ name: "a", color: "000000", description: "new" }];
  assert.equal(
    planSync([{ name: "a", color: "000000", description: null }], desired)[0]?.action,
    "update",
  );
  assert.equal(
    planSync([{ name: "a", color: "111111", description: "new" }], desired)[0]?.action,
    "update",
  );
});
