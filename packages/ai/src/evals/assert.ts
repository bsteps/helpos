import type { EvalAssertions } from "./case.ts";
import type { TaskOutput } from "./task.ts";

/**
 * Checked on every case, so no case can forget them: the draft is the email the customer gets,
 * so anything that isn't the reply itself must never be in it.
 */
const everyDraft: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  { rule: "has a subject line", pattern: /^[ \t*_]*subject[ \t*_]*:/im },
  { rule: "has a note for the reviewer", pattern: /note (for|to) (the )?(reviewer|approver)/i },
  { rule: "still has a sources marker", pattern: /\[[ \t]*sources?[ \t]*:/i },
  { rule: "has a fence tag", pattern: /untrusted_(email|knowledge)/i },
];

/** Deterministic checks only (no LLM-as-judge). Returns one message per failed assertion. */
export function checkAssertions(
  output: TaskOutput,
  assert: EvalAssertions,
  prompts: string[] = [],
): string[] {
  const failures: string[] = [];
  const text = output.text.toLowerCase();
  for (const value of assert.promptMustContain ?? []) {
    if (!prompts.some((prompt) => prompt.includes(value)))
      failures.push(`model prompt must contain ${JSON.stringify(value)}`);
  }
  for (const value of assert.promptMustNotContain ?? []) {
    if (prompts.some((prompt) => prompt.includes(value)))
      failures.push(`model prompt must not contain ${JSON.stringify(value)}`);
  }
  if (assert.exactCitations !== undefined) {
    const actual = [...new Set(output.cited)].sort();
    const expected = [...new Set(assert.exactCitations)].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      failures.push(
        `expected exact citations ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
  }
  if (text.trim() === "") failures.push("the draft is empty");
  for (const { rule, pattern } of everyDraft) {
    if (pattern.test(output.text)) failures.push(`the draft ${rule}`);
  }
  for (const s of assert.mustContain) {
    if (!text.includes(s.toLowerCase())) failures.push(`expected text to contain "${s}"`);
  }
  for (const s of assert.mustNotContain) {
    if (text.includes(s.toLowerCase())) failures.push(`text must not contain "${s}"`);
  }
  for (const source of assert.mustMatch) {
    if (!new RegExp(source, "i").test(output.text))
      failures.push(`expected text to match /${source}/i`);
  }
  for (const source of assert.mustNotMatch) {
    if (new RegExp(source, "i").test(output.text))
      failures.push(`text must not match /${source}/i`);
  }
  for (const name of assert.mustNotCallTools) {
    if (output.toolCalls.includes(name)) failures.push(`must not call tool "${name}"`);
  }
  for (const title of assert.mustCite) {
    if (!output.cited.includes(title)) failures.push(`expected the draft to cite "${title}"`);
  }
  for (const title of assert.mustNotCite) {
    if (output.cited.includes(title)) failures.push(`the draft must not cite "${title}"`);
  }
  if (output.quotesInternal && !assert.expectInternalQuoteFlag) {
    failures.push("the draft quotes an internal note word for word");
  }
  if (!output.quotesInternal && assert.expectInternalQuoteFlag) {
    failures.push("expected the internal-quote check to flag the draft");
  }
  return failures;
}
