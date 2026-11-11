import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";

function rawDraftStatusSql(source) {
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
  const matches = [];
  function visit(node) {
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText(file) === "sql") {
      const text = node.template.getText(file);
      if (
        /drafts\.status/.test(text) &&
        /'(pending|approved|sent|discarded|send_failed|send_uncertain)'/.test(text)
      )
        matches.push(text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return matches;
}

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? sources(path)
      : path.endsWith(".ts") && !path.endsWith(".test.ts") && entry.name !== "lifecycle.ts"
        ? [path]
        : [];
  });
}

test("draft SQL status literals stay in lifecycle", () => {
  for (const path of sources("apps/server/src")) {
    assert.deepEqual(rawDraftStatusSql(readFileSync(path, "utf8")), [], path);
  }
});

test("the guard rejects raw equality and status lists, but accepts named checks", () => {
  for (const source of [
    "sql`where ${drafts.status} = 'pending'`",
    "sql<boolean>`where ${drafts.status} in ('send_failed', 'send_uncertain')`",
  ])
    assert.equal(rawDraftStatusSql(source).length, 1);
  assert.equal(rawDraftStatusSql("sql`where ${draftWhere.sendFailed()}`").length, 0);
});
