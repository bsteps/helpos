import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

test("AI helpers reject raw models and accept models from budget.spend", () => {
  const dir = resolve(`apps/server/src/paid-type-fixture-${process.pid}`);
  const file = resolve(dir, "calls.ts");
  mkdirSync(dir, { recursive: true });
  const configPath = resolve("apps/server/tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve("apps/server"));
  const source = (paid) => `
import { draftReply, embedTexts } from "@helpos/ai";
import { mockModel, mockEmbeddingModel } from "@helpos/ai/testing";
import type { TenantTransaction } from "@helpos/db";
import type { AiBudget, Reservation } from "../ai-budget/budget.ts";
export async function check(budget: AiBudget, tx: TenantTransaction, reservation: Reservation) {
  ${paid ? "return budget.spend(tx, reservation, async (_signal, models) => {" : ""}
    const input = { from: "a", subject: "b", body: "c" };
    await draftReply(${paid ? "models(mockModel())" : "mockModel()"}, input);
    await embedTexts(${paid ? "models(mockEmbeddingModel())" : "mockEmbeddingModel()"}, ["x"]);
    return { inputTokens: 1, outputTokens: 1 };
  ${paid ? '}, { of: (value) => value, ofFailure: () => "unknown" });' : ""}
}`;
  const compile = (paid) => {
    writeFileSync(file, source(paid));
    return ts.getPreEmitDiagnostics(
      ts.createProgram([file], { ...options, noUnusedLocals: false, noUnusedParameters: false }),
    );
  };
  try {
    assert.deepEqual(compile(true), []);
    const errors = compile(false);
    assert.equal(errors.length, 2);
    for (const error of errors) {
      assert.equal(error.code, 2345);
      assert.match(ts.flattenDiagnosticMessageText(error.messageText, "\n"), /PaidModel/);
      assert.equal(error.file?.fileName, file.replaceAll("\\", "/"));
    }
    assert.deepEqual(compile(true), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
