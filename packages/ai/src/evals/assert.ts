import type { EvalAssertions } from "./case.ts";
import type { TaskOutput } from "./task.ts";

/** Deterministic checks only (no LLM-as-judge). Returns one message per failed assertion. */
export function checkAssertions(output: TaskOutput, assert: EvalAssertions): string[] {
  const failures: string[] = [];
  const text = output.text.toLowerCase();
  for (const s of assert.mustContain) {
    if (!text.includes(s.toLowerCase())) failures.push(`expected text to contain "${s}"`);
  }
  for (const s of assert.mustNotContain) {
    if (text.includes(s.toLowerCase())) failures.push(`text must not contain "${s}"`);
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
  return failures;
}
