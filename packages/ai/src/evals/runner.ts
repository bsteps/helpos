import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { mockModel } from "../testing.ts";
import { checkAssertions } from "./assert.ts";
import { type EvalCase, evalCaseSchema } from "./case.ts";
import { draftReplyTask } from "./task.ts";

export type EvalResult = { file: string; name: string; failures: string[] };

export async function loadCases(dir: string): Promise<Array<{ file: string; evalCase: EvalCase }>> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(
    files.map(async (file) => {
      const raw: unknown = JSON.parse(await readFile(join(dir, file), "utf8"));
      const parsed = evalCaseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`Invalid eval case ${file}: ${parsed.error.message}`);
      }
      return { file, evalCase: parsed.data };
    }),
  );
}

/**
 * Runs every case in `dir`. With no `liveModel`, each case gets a mock that returns its scripted
 * answer, so CI is deterministic and offline. A case that throws counts as failed, never skipped.
 */
export async function runEvals(dir: string, liveModel?: LanguageModel): Promise<EvalResult[]> {
  const cases = await loadCases(dir);
  const results: EvalResult[] = [];
  for (const { file, evalCase } of cases) {
    const model = liveModel ?? mockModel(evalCase.mock);
    try {
      const output = await draftReplyTask(model, evalCase.input);
      results.push({
        file,
        name: evalCase.name,
        // A live model isn't scripted to obey the injection, so it must not be flagged at all.
        failures: checkAssertions(
          output,
          liveModel ? { ...evalCase.assert, expectInternalQuoteFlag: false } : evalCase.assert,
        ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ file, name: evalCase.name, failures: [`task threw: ${message}`] });
    }
  }
  return results;
}
