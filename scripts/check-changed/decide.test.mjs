import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "./decide.mjs";

test("docs-only changes lint but skip typecheck, tests and evals", () => {
  const d = decide(["README.md", "docs/adr/0001-x.md", "packages/ai/README.md"]);
  assert.equal(d.scope, "none");
  assert.equal(d.evals, false);
  assert.deepEqual(d.lintFiles, ["README.md", "docs/adr/0001-x.md", "packages/ai/README.md"]);
});

test("one package checks that package and its dependents", () => {
  const d = decide(["apps/server/src/routes/tickets.ts", "AGENTS.md"]);
  assert.equal(d.scope, "affected");
  assert.equal(d.evals, false);
});

test("a shared package is still affected-only; Turbo adds its dependents", () => {
  assert.equal(decide(["packages/db/src/tenant.ts"]).scope, "affected");
});

test("root config runs everything", () => {
  for (const f of ["package.json", "pnpm-lock.yaml", "turbo.json", "tsconfig.base.json"]) {
    const d = decide([f]);
    assert.equal(d.scope, "all", f);
    assert.equal(d.evals, true, f);
  }
});

test("shared test setup runs everything", () => {
  assert.equal(decide(["packages/db/vitest.config.ts"]).scope, "all");
  assert.equal(decide(["fixtures/email/plain.eml"]).scope, "all");
  assert.equal(decide(["apps/web/tsconfig.json"]).scope, "all");
});

test("evals run only when AI prompts or eval cases change", () => {
  assert.equal(decide(["packages/ai/src/draft-reply.ts"]).evals, true);
  assert.equal(decide(["packages/ai/evals/knowledge-injection.json"]).evals, true);
  assert.equal(decide(["packages/ai/src/draft-reply.test.ts"]).evals, false);
  assert.equal(decide(["apps/server/src/index.ts"]).evals, false);
});

test("files outside the workspace that aren't config skip typecheck", () => {
  assert.equal(decide([".github/workflows/ci.yml", "docker/Caddyfile"]).scope, "none");
});

test("normalises Windows paths and drops duplicates", () => {
  const d = decide(["appsservera.ts", "apps/server/a.ts", ""]);
  assert.deepEqual(d.lintFiles, ["apps/server/a.ts"]);
  assert.equal(d.scope, "affected");
});
