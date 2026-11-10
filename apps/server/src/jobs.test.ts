import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jobs } from "./jobs.ts";

const srcDir = fileURLToPath(new URL(".", import.meta.url));

/** Every queue a source file defines with defineTenantJob("…"). Tests are left out. */
function definedQueues(): string[] {
  const queues: string[] = [];
  for (const entry of readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.includes(".test.")) continue;
    const text = readFileSync(join(entry.parentPath, entry.name), "utf8");
    for (const m of text.matchAll(/defineTenantJob\(\s*"([^"]+)"/g)) if (m[1]) queues.push(m[1]);
  }
  return queues;
}

describe("the job registry", () => {
  it("has every job the server defines, each once", () => {
    // A job defined but not registered has no queue (enqueue() then fails at runtime with
    // "unknown queue") and nothing works it.
    const registered = jobs.map((j) => j.queue);
    expect(new Set(registered).size).toBe(registered.length);
    expect([...registered].sort()).toEqual([...new Set(definedQueues())].sort());
  });
});
