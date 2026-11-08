// `pnpm db:seed`: fills a local database with two demo workspaces, their users, agent tokens,
// tickets, drafts and knowledge sources. The same data every run, and safe to run again.
// Refuses production: the demo tokens are public.
import { createAuthStore, createDatabase, createJobRunner } from "@helpos/db";
import { z } from "zod";
import { checkSeedTarget } from "../seed/guard.ts";
import { seedDemoData } from "../seed/seed.ts";

const env = z
  .object({
    HELPOS_DATABASE_URL: z.url(),
    HELPOS_DATABASE_AUTH_URL: z.url(),
    HELPOS_DATABASE_JOBS_URL: z.url(),
  })
  .parse(process.env);

const guard = checkSeedTarget(process.env, [
  env.HELPOS_DATABASE_URL,
  env.HELPOS_DATABASE_AUTH_URL,
  env.HELPOS_DATABASE_JOBS_URL,
]);
if (!guard.ok) {
  process.stderr.write(
    `Refusing to seed: ${guard.reason}. The seed is for local databases only.\n`,
  );
  process.exit(1);
}

const db = createDatabase(env.HELPOS_DATABASE_URL);
const auth = createAuthStore(env.HELPOS_DATABASE_AUTH_URL);
const jobs = createJobRunner({
  jobsUrl: env.HELPOS_DATABASE_JOBS_URL,
  db,
  onError: (error) =>
    process.stderr.write(`Job queue error: ${String(error)}
`),
});
try {
  await jobs.start();
  const result = await seedDemoData({ db, auth, jobs });
  if (!result.ok) {
    process.stderr.write(`The mailbox ${result.mailbox} belongs to another workspace.\n`);
    process.exitCode = 1;
  } else {
    if (result.skipped.length > 0) {
      process.stdout.write(
        `Already seeded, left as is: ${result.skipped.join(", ")}. ` +
          "To pick up changed demo data, reset the database (docker compose down -v, then pnpm dev).\n",
      );
    }
    for (const t of result.data.tenants) {
      process.stdout.write(
        `\n${t.tenant.name} (${t.mailbox.address}), ${t.tickets.length} tickets\n`,
      );
      for (const m of t.memberships) process.stdout.write(`  ${m.role.padEnd(6)} ${m.email}\n`);
      for (const k of t.tokens.filter((k) => !k.revokedAt)) {
        process.stdout.write(
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
