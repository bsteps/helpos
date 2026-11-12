import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkWidgetBudget } from "./check-widget-budget.mjs";

test("widget adoption fails closed for missing, empty and oversized build output", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-budget-"));
  const widget = join(root, "apps/widget");
  const dist = join(widget, "dist");
  try {
    assert.equal(checkWidgetBudget(root).status, "absent");
    mkdirSync(widget, { recursive: true });
    assert.throws(() => checkWidgetBudget(root), /ENOENT/);
    mkdirSync(dist);
    assert.throws(() => checkWidgetBudget(root), /no JavaScript or CSS/);
    writeFileSync(join(dist, "loader.js"), "export const ready = true;");
    assert.equal(checkWidgetBudget(root).status, "checked");
    writeFileSync(join(dist, "chat.css"), randomBytes(21 * 1024));
    assert.throws(() => checkWidgetBudget(root), /exceeds 20 KB/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
