import { expect, it } from "vitest";
import { run as budget } from "./ai-budget-command.ts";
import { run as init } from "./init-command.ts";
import { run as seed } from "./seed-command.ts";
import { run as token } from "./token-command.ts";

const commands = [
  { name: "helpos:init", run: init, missing: [["--workspace"]] },
  { name: "helpos:token", run: token, missing: [["--mailbox"]] },
  { name: "helpos:ai-budget", run: budget, missing: [["--tokens"]] },
  { name: "db:seed", run: seed, missing: [] },
];
for (const command of commands) {
  for (const args of [["--unknown"], ["unexpected"], ...command.missing]) {
    it(`${command.name} rejects ${JSON.stringify(args)} before requiring environment`, async () => {
      let stdout = "";
      let stderr = "";
      const code = await command.run(
        args,
        {},
        {
          stdout: {
            write: (text) => {
              stdout += text;
            },
          },
          stderr: {
            write: (text) => {
              stderr += text;
            },
          },
        },
      );
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain(`Usage: pnpm ${command.name}`);
    });
  }
}
it.each([
  { run: init, args: [] },
  {
    run: token,
    args: ["--mailbox", "x@test.test", "--name", "bot", "--scopes", "workspace:admin"],
  },
  { run: budget, args: ["--workspace", "00000000-0000-4000-8000-000000000001", "--tokens", "-1"] },
  { run: budget, args: ["--workspace", "invalid", "--tokens", "default"] },
])("rejects invalid or incomplete values", async ({ run, args }) => {
  let error = "";
  expect(
    await run(
      args,
      {},
      {
        stdout: {
          write: () => {
            throw new Error("unexpected stdout");
          },
        },
        stderr: {
          write: (text) => {
            error += text;
          },
        },
      },
    ),
  ).toBe(2);
  expect(error).toMatch(/^Usage:/);
});
it("seed refuses production even when its database URLs are local", async () => {
  let error = "";
  const url = "postgres://localhost/unused";
  expect(
    await seed(
      [],
      {
        NODE_ENV: "production",
        HELPOS_DATABASE_URL: url,
        HELPOS_DATABASE_AUTH_URL: url,
        HELPOS_DATABASE_JOBS_URL: url,
      },
      {
        stdout: {
          write: () => {
            throw new Error("unexpected stdout");
          },
        },
        stderr: {
          write: (text) => {
            error += text;
          },
        },
      },
    ),
  ).toBe(1);
  expect(error).toBe(
    'Refusing to seed: NODE_ENV is "production". The seed is for local databases only.\n',
  );
});
