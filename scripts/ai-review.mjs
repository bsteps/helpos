// Turns the AI reviewer's findings (JSON from Codex) into a PR review body, and
// decides whether the required check fails. Used by .github/workflows/ai-review.yml.
//
// Usage: node scripts/ai-review.mjs <findings.json> <review-out.json>
// Exit code 1 when any finding is high or critical, or when the findings are invalid.
//
// The findings are model output about untrusted PR code, so they are treated as data:
// shape-checked, length-capped, and @mentions are defused before posting.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SEVERITIES = ["critical", "high", "medium", "low"];
const BLOCKING = new Set(["critical", "high"]);
// 30 × ~2 KB per finding stays well under GitHub's 65,536-character review body limit.
const MAX_FINDINGS = 30;
const MAX_TEXT = 1500;

/** Throws when the data isn't the shape .github/ai-review/findings.schema.json describes. */
export function parseFindings(data) {
  if (typeof data !== "object" || data === null || !Array.isArray(data.findings)) {
    throw new Error("findings: expected an object with a `findings` array");
  }
  if (typeof data.summary !== "string") throw new Error("findings: `summary` must be a string");
  return {
    summary: data.summary,
    findings: data.findings.map((f, i) => {
      if (typeof f !== "object" || f === null) throw new Error(`finding ${i}: not an object`);
      if (!SEVERITIES.includes(f.severity)) throw new Error(`finding ${i}: bad severity`);
      for (const key of ["title", "file", "explanation"]) {
        if (typeof f[key] !== "string")
          throw new Error(`finding ${i}: \`${key}\` must be a string`);
      }
      if (!Number.isInteger(f.line)) throw new Error(`finding ${i}: \`line\` must be an integer`);
      return {
        severity: f.severity,
        title: f.title,
        file: f.file,
        line: f.line,
        explanation: f.explanation,
      };
    }),
  };
}

export function isBlocking(findings) {
  return findings.some((f) => BLOCKING.has(f.severity));
}

/** Model text goes into a GitHub comment: stop it pinging people or breaking out of code spans. */
export function clean(text) {
  const capped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
  return capped.replaceAll("@", "@​");
}

export function renderReview({ summary, findings }) {
  const sorted = [...findings].sort(
    (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity),
  );
  const shown = sorted.slice(0, MAX_FINDINGS);
  const verdict = isBlocking(findings)
    ? "❌ **High or critical findings. The required check fails until they are fixed.**"
    : "✅ No high or critical findings.";
  const lines = ["## AI security review", "", verdict, "", clean(summary)];
  for (const f of shown) {
    const where = f.line > 0 ? `${f.file}:${f.line}` : f.file;
    lines.push(
      "",
      `### [${f.severity}] ${clean(f.title)}`,
      `\`${clean(where).replaceAll("`", "")}\``,
      "",
      clean(f.explanation),
    );
  }
  if (sorted.length > shown.length) lines.push("", `…and ${sorted.length - shown.length} more.`);
  lines.push(
    "",
    "<sub>Independent AI review (a different model from the code author). Advisory: a human still decides.</sub>",
  );
  return lines.join("\n");
}

function main([input, output]) {
  if (!input || !output)
    throw new Error("usage: node scripts/ai-review.mjs <findings.json> <review-out.json>");
  const findings = parseFindings(JSON.parse(readFileSync(input, "utf8")));
  writeFileSync(output, JSON.stringify({ event: "COMMENT", body: renderReview(findings) }));
  return isBlocking(findings.findings) ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ai-review: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
