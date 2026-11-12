import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { cpus, loadavg, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { createAuthStore, createDatabase } from "@helpos/db";
import { startTestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { getRequestListener } from "@hono/node-server";
import { z } from "zod";
import { createLogger } from "../src/logger.ts";
import { seedDemoData } from "../src/seed/seed.ts";
import { composeServer } from "../src/server.ts";

const reportPath = resolve(process.argv[2] ?? "../../.helpos/read-budget.json");
const conversationList = z.object({
  conversations: z.array(z.object({ id: z.string(), subject: z.string() })),
});
const conversationDetail = z.object({
  id: z.string(),
  subject: z.string(),
  messages: z.array(z.object({ id: z.string(), text: z.string() })),
});
const testDb = await startTestDatabase();
const db = createDatabase(testDb.appUrl);
const auth = createAuthStore(testDb.authUrl);
const server = composeServer({
  db,
  auth,
  jobsUrl: testDb.jobsUrl,
  files: createMemoryFileStore(),
  logger: createLogger({ level: "error" }),
});
const http = createServer(getRequestListener(server.app().fetch));
http.listen(0, "127.0.0.1");

try {
  await server.runner.start();
  const seeded = await seedDemoData({
    db,
    auth,
    jobs: server.runner,
    config: server.services.config,
  });
  assert.ok(seeded.ok, "seed must succeed");
  assert.deepEqual(seeded.skipped, [], "benchmark must use a fresh database");
  if (!http.listening) await new Promise<void>((done) => http.once("listening", done));
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const workloads = seeded.data.tenants.flatMap((tenant) => {
    const token = tenant.tokens.find(
      (token) => token.scopes.includes("conversations:read") && !token.revokedAt,
    );
    assert.ok(token);
    const conversation = tenant.conversations[0];
    assert.ok(conversation);
    const expected = tenant.messages.filter(
      (message) => message.conversationId === conversation.id,
    );
    return [
      {
        name: `${tenant.key}/list`,
        path: "/v1/conversations?limit=100",
        token: token.token,
        validate(body: string) {
          const data = conversationList.parse(JSON.parse(body));
          assert.deepEqual(
            data.conversations.map((row) => [row.id, row.subject]).sort(),
            tenant.conversations.map((row) => [row.id, row.subject]).sort(),
          );
        },
      },
      {
        name: `${tenant.key}/detail`,
        path: `/v1/conversations/${conversation.id}`,
        token: token.token,
        validate(body: string) {
          const data = conversationDetail.parse(JSON.parse(body));
          assert.equal(data.id, conversation.id);
          assert.equal(data.subject, conversation.subject);
          assert.ok(expected.length > 0);
          assert.deepEqual(
            data.messages.map((row) => [row.id, row.text]).sort(),
            expected.map((row) => [row.id, row.textBody]).sort(),
          );
        },
      },
    ];
  });
  const refusal = await fetch(`${base}${workloads[0]?.path}`);
  assert.equal(refusal.status, 401, "reads must require genuine authentication");
  await refusal.text();
  const results = [];
  let warmupErrors = 0;
  for (let round = 0; round < 5; round++) {
    for (const workload of workloads) {
      const samples = [];
      const errors: string[] = [];
      let bytes = 0;
      let successfulReads = 0;
      for (let sample = -20; sample < 100; sample++) {
        const start = performance.now();
        try {
          const response = await fetch(`${base}${workload.path}`, {
            headers: { authorization: `Bearer ${workload.token}` },
            signal: AbortSignal.timeout(5_000),
          });
          const body = await response.text();
          const elapsed = performance.now() - start;
          assert.equal(response.status, 200);
          workload.validate(body);
          if (sample >= 0) {
            samples.push(elapsed);
            bytes += Buffer.byteLength(body);
            successfulReads++;
          }
        } catch (error) {
          if (sample < 0) warmupErrors++;
          else samples.push(performance.now() - start);
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1];
      assert.ok(p95 !== undefined);
      results.push({
        round: round + 1,
        workload: workload.name,
        samples,
        p95,
        errors,
        bytes,
        successfulReads,
      });
      process.stdout.write(
        `${workload.name} round ${round + 1}: p95 ${p95.toFixed(2)} ms, ${successfulReads} reads, ${errors.length} errors\n`,
      );
    }
  }
  const report = {
    head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
    timestamp: new Date().toISOString(),
    host: {
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      memory: totalmem(),
      loadavg: loadavg(),
      node: process.version,
    },
    database:
      "disposable pgvector/pgvector:pg17; startTestDatabase migrations; durability disabled by test helper",
    dataset: seeded.data.tenants.map((tenant) => ({
      tenant: tenant.key,
      conversations: tenant.conversations.length,
      messages: tenant.messages.length,
      drafts: tenant.drafts.length,
    })),
    method:
      "5 rounds, 20 warmup reads per workload per round, 100 sequential measured reads per workload; nearest-rank p95; fetch through complete response body; validation outside timing; no retries; warm pools",
    budgetMs: 100,
    warmupErrors,
    results,
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  assert.equal(warmupErrors, 0, "warmup reads must succeed");
  assert.ok(
    results.every(
      (result) => result.errors.length === 0 && result.successfulReads === 100 && result.p95 < 100,
    ),
    "API read p95 must be strictly below 100 ms in every workload and round, with zero errors",
  );
} finally {
  http.closeAllConnections();
  await new Promise<void>((done, reject) =>
    http.close((error) => (error ? reject(error) : done())),
  );
  await server.stopWorker();
  await Promise.all([db.close(), auth.close()]);
  await testDb.stop();
}
