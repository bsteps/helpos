import assert from "node:assert/strict";
import { test } from "node:test";
import { clean, isBlocking, parseFindings, renderReview } from "./ai-review.mjs";

const finding = (severity, extra = {}) => ({
  severity,
  title: "Missing withTenant()",
  file: "apps/server/src/x.ts",
  line: 12,
  explanation: "Query runs outside the tenant wrapper.",
  ...extra,
});

test("high and critical findings block, medium and low don't", () => {
  assert.equal(isBlocking([finding("critical")]), true);
  assert.equal(isBlocking([finding("low"), finding("high")]), true);
  assert.equal(isBlocking([finding("medium"), finding("low")]), false);
  assert.equal(isBlocking([]), false);
});

test("rejects findings that don't match the schema", () => {
  assert.throws(() => parseFindings(null));
  assert.throws(() => parseFindings({ summary: "x" }));
  assert.throws(() => parseFindings({ summary: "x", findings: [finding("urgent")] }));
  assert.throws(() => parseFindings({ summary: "x", findings: [finding("high", { line: "12" })] }));
  assert.throws(() => parseFindings({ findings: [] }));
});

test("drops unknown fields", () => {
  const parsed = parseFindings({ summary: "ok", findings: [finding("low", { extra: "x" })] });
  assert.equal("extra" in (parsed.findings[0] ?? {}), false);
});

test("defuses @mentions and caps length", () => {
  assert.equal(clean("ping @bsteps").includes("@bsteps"), false);
  assert.ok(clean("a".repeat(5000)).length < 2100);
});

test("review lists the worst findings first and states the verdict", () => {
  const body = renderReview({
    summary: "Looked at auth.",
    findings: [finding("low"), finding("critical")],
  });
  assert.ok(body.indexOf("[critical]") < body.indexOf("[low]"));
  assert.match(body, /required check fails/);
  assert.match(renderReview({ summary: "Fine.", findings: [] }), /No high or critical findings/);
});

test("a huge review still fits GitHub's 65,536-character body limit", () => {
  const long = "x".repeat(10_000);
  const findings = Array.from({ length: 200 }, () =>
    finding("high", { title: long, file: long, explanation: long }),
  );
  assert.ok(renderReview({ summary: long, findings }).length < 65_536);
});
