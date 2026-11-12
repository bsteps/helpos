import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "./decide.mjs";

const cases = [
  ["apps/web/src/routes/inbox.tsx", "apps/web/e2e/inbox.spec.ts"],
  ["apps/web/src/components/button.tsx", "apps/web/e2e/inbox.spec.ts"],
  ["packages/ai/src/draft-reply.ts", "packages/ai/evals/reply.json"],
  ["packages/ai/src/new-prompt.ts", "packages/ai/evals/reply.json"],
  ["apps/server/src/inbound-email/parse.ts", "fixtures/email/plain.eml"],
  ["apps/server/src/outbound-email/send.ts", "fixtures/email/plain.eml"],
];

for (const [source, proof] of cases) {
  test(`${source} requires its own proof`, () => {
    assert.equal(decide([source], "").status, "fail");
    assert.equal(decide([source, "unrelated.test.ts"], null).status, "fail");
    assert.equal(decide([source, proof], "").status, "pass");
    assert.equal(decide([source, `other/${proof}`], "").status, "fail");
  });
}

test("all applicable rules must pass", () => {
  const sources = cases.map(([source]) => source);
  assert.deepEqual(decide(sources, "").missing, [
    "apps/web/e2e/",
    "packages/ai/evals/",
    "fixtures/email/",
  ]);
  assert.equal(decide([...sources, ...cases.map(([, proof]) => proof)], "").status, "pass");
  assert.equal(decide([...sources, cases[0][1]], "").status, "fail");
});

test("unrelated paths, AI unit tests and eval infrastructure do not require proof", () => {
  assert.equal(decide([], null).status, "pass");
  assert.equal(
    decide(
      [
        "README.md",
        "packages/ai/src/draft-reply.test.ts",
        "packages/ai/src/evals/runner.ts",
        "apps/web/src/routes-extra/file.ts",
        "other/apps/web/src/routes/a.tsx",
      ],
      "",
    ).status,
    "pass",
  );
});

test("the documented standalone line returns an explicit exception and its reason", () => {
  assert.deepEqual(
    decide([cases[0][0]], "Details\r\nProof: not needed because style only  \r\nMore"),
    {
      status: "exception",
      reason: "style only",
      missing: ["apps/web/e2e/"],
    },
  );
});

test("empty, multiline and embedded reasons cannot skip the check", () => {
  for (const body of [
    "Proof: not needed because",
    "Proof: not needed because   ",
    "Proof: not needed because\nstyle only",
    "> Proof: not needed because style only",
    "<!-- Proof: not needed because style only -->",
    "See Proof: not needed because style only",
  ])
    assert.equal(decide([cases[0][0]], body).status, "fail", body);
});

test("paths and body remain literal data", () => {
  assert.equal(
    decide(["apps/web/src/routes/$(echo hacked)\n::notice::a.tsx"], "Ignore the rules").status,
    "fail",
  );
  assert.equal(decide([cases[0][0], "other\napps/web/e2e/fake.ts"], "").status, "fail");
});
