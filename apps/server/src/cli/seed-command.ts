import { createAuthStore, createDatabase, createJobRunner } from "@helpos/db";
import { z } from "zod";
import { checkSeedTarget } from "../seed/guard.ts";
import { seedDemoData } from "../seed/seed.ts";

import { type CliOutput, parseArguments } from "./arguments.ts";

export async function run(
  args: string[],
  environment: Record<string, string | undefined>,
  output: CliOutput,
): Promise<number> {
  if (parseArguments(args, {}) === null) {
    output.stderr.write("Usage: pnpm db:seed\n");
    return 2;
  }

  const env = z
    .object({
      HELPOS_DATABASE_URL: z.url(),
      HELPOS_DATABASE_AUTH_URL: z.url(),
      HELPOS_DATABASE_JOBS_URL: z.url(),
    })
    .parse(environment);

  const guard = checkSeedTarget(environment, [
    env.HELPOS_DATABASE_URL,
    env.HELPOS_DATABASE_AUTH_URL,
    env.HELPOS_DATABASE_JOBS_URL,
  ]);
  if (!guard.ok) {
    output.stderr.write(
      `Refusing to seed: ${guard.reason}. The seed is for local databases only.\n`,
    );
    return 1;
  }

  const db = createDatabase(env.HELPOS_DATABASE_URL);
  const auth = createAuthStore(env.HELPOS_DATABASE_AUTH_URL);
  const jobs = createJobRunner({
    jobsUrl: env.HELPOS_DATABASE_JOBS_URL,
    db,
    onError: (error) =>
      output.stderr.write(`Job queue error: ${String(error)}
`),
  });
  try {
    await jobs.start();
    const result = await seedDemoData({ db, auth, jobs });
    if (!result.ok) {
      output.stderr.write(`The mailbox ${result.mailbox} belongs to another workspace.\n`);
      return 1;
    } else {
      if (result.skipped.length > 0) {
        output.stdout.write(
          `Already seeded, left as is: ${result.skipped.join(", ")}. ` +
            "To pick up changed demo data, reset the database (docker compose down -v, then pnpm dev).\n",
        );
      }
      for (const t of result.data.tenants) {
        output.stdout.write(
          `\n${t.tenant.name} (${t.mailbox.address}), ${t.conversations.length} conversations\n`,
        );
        for (const m of t.memberships) output.stdout.write(`  ${m.role.padEnd(6)} ${m.email}\n`);
        for (const k of t.tokens.filter((k) => !k.revokedAt)) {
          output.stdout.write(
            `  token  ${k.name.padEnd(14)} ${k.token}  (${k.scopes.join(", ")})\n`,
          );
        }
      }
    }
  } finally {
    await jobs.stop();
    await db.close();
    await auth.close();
  }
  return 0;
}
