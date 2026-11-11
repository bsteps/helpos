import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type AuthStore, createAuthStore, createDatabase, type Database } from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { composeServices } from "../services.ts";

let testDb: TestDatabase;
let db: Database;
let auth: AuthStore;
const origin = "http://localhost:3000";
beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
});
afterAll(async () => {
  await db?.close();
  await auth?.close();
  await testDb?.stop();
});

it("the executable prints a one-time link that sets the owner's password through the API", async () => {
  const cli = fileURLToPath(new URL("./init.ts", import.meta.url));
  const args = [
    "--workspace",
    "CLI Acme",
    "--mailbox",
    "support@cli.test",
    "--owner",
    "owner@cli.test",
  ];
  const env = {
    ...process.env,
    HELPOS_DATABASE_URL: testDb.appUrl,
    HELPOS_DATABASE_AUTH_URL: testDb.authUrl,
    HELPOS_PUBLIC_URL: origin,
  };
  const first = await promisify(execFile)(process.execPath, [cli, ...args], { env });
  expect(first.stderr).toBe("");
  expect(first.stdout).toMatch(/^Created workspace [\da-f-]+ \(support@cli.test\)\./);
  const link = first.stdout.match(/http:\/\/localhost:3000\/set-password#token=\S+/)?.[0];
  expect(Boolean(link)).toBe(true);
  const token = new URLSearchParams(new URL(link ?? origin).hash.slice(1)).get("token");
  const app = createApp(
    composeServices({
      db,
      auth,
      files: createMemoryFileStore(),
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
      config: { publicUrl: origin },
    }),
  );
  const setPassword = () =>
    app.request("/v1/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ token, password: "CLI owner test password" }),
    });
  expect((await setPassword()).status).toBe(204);
  expect((await setPassword()).status).toBe(400);
  const second = await promisify(execFile)(process.execPath, [cli, ...args], { env });
  expect(second.stdout).toMatch(/^Already set up: workspace/);
  expect(second.stdout).toContain("owner@cli.test already has a password.");
  expect(second.stdout.includes("#token=")).toBe(false);
});

it("run functions print usable tokens, budget results and repeatable seed summaries", async () => {
  const { run: init } = await import("./init-command.ts");
  const { run: token } = await import("./token-command.ts");
  const { run: budget } = await import("./ai-budget-command.ts");
  const { run: seed } = await import("./seed-command.ts");
  const { hashToken } = await import("../tokens/token.ts");
  const { schema } = await import("@helpos/db");
  const env = {
    HELPOS_DATABASE_URL: testDb.appUrl,
    HELPOS_DATABASE_AUTH_URL: testDb.authUrl,
    HELPOS_DATABASE_JOBS_URL: testDb.jobsUrl,
  };
  let stdout = "";
  let stderr = "";
  const output = {
    stdout: {
      write: (text: string) => {
        stdout += text;
      },
    },
    stderr: {
      write: (text: string) => {
        stderr += text;
      },
    },
  };
  expect(
    await init(
      ["--workspace", "Run", "--mailbox", "run@cli.test", "--owner", "run-owner@cli.test"],
      env,
      output,
    ),
  ).toBe(0);
  expect(stdout.includes("http://localhost:3000/set-password#token=")).toBe(true);
  const route = await db.resolveMailbox("run@cli.test");
  if (!route) throw new Error("CLI did not create the mailbox");
  stdout = "";
  expect(
    await token(
      [
        "--mailbox",
        "Run@cli.test",
        "--name",
        "cli-bot",
        "--scopes",
        "conversations:read, drafts:write",
      ],
      env,
      output,
    ),
  ).toBe(0);
  expect(/^hos_[A-Za-z0-9_-]{43}\n$/.test(stdout)).toBe(true);
  expect(stderr.includes(stdout.trim())).toBe(false);
  expect(await db.resolveApiToken(hashToken(stdout.trim()))).toMatchObject({
    tenantId: route.tenantId,
    name: "cli-bot",
    scopes: ["conversations:read", "drafts:write"],
  });
  for (const value of ["50000", "0", "default"]) {
    stdout = "";
    expect(await budget(["--workspace", route.tenantId, "--tokens", value], env, output)).toBe(0);
    expect(stdout).toBe(
      `Workspace ${route.tenantId}: daily AI budget set to ${value === "default" ? "the server default" : value}.\n`,
    );
    const rows = await db.withTenant(route.tenantId, (tx) => tx.select().from(schema.tenants));
    expect(rows[0]?.aiDailyTokenBudget).toBe(value === "default" ? null : Number(value));
  }
  stdout = "";
  stderr = "";
  expect(
    await budget(
      ["--workspace", "00000000-0000-4000-8000-000000000001", "--tokens", "10"],
      env,
      output,
    ),
  ).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toBe("No workspace 00000000-0000-4000-8000-000000000001.\n");
  for (const repeated of [false, true]) {
    stdout = "";
    stderr = "";
    expect(await seed([], env, output)).toBe(0);
    expect(stdout.includes("Northwind Cycles")).toBe(true);
    expect(stdout.includes("Already seeded, left as is:")).toBe(repeated);
    expect(stderr).toBe("");
  }
});

it.each(["init", "token", "ai-budget", "seed"])(
  "%s executable returns usage exit 2",
  async (name) => {
    const cli = fileURLToPath(new URL(`./${name}.ts`, import.meta.url));
    const result = await new Promise<{
      code: number | string | undefined;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      execFile(
        process.execPath,
        [cli, "--unknown"],
        {
          env: {
            ...process.env,
            HELPOS_DATABASE_URL: "",
            HELPOS_DATABASE_AUTH_URL: "",
            HELPOS_DATABASE_JOBS_URL: "",
          },
        },
        (error, stdout, stderr) => resolve({ code: error?.code, stdout, stderr }),
      );
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^Usage: pnpm /);
  },
);
