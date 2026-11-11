import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import drizzleConfig from "../drizzle.config.ts";
import { installJobs } from "./jobs.ts";
import { runMigrations } from "./migrate.ts";
import { startTestDatabase, type TestDatabase } from "./testing.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = join(packageDir, "migrations");
const drizzleKit = join(packageDir, "node_modules", "drizzle-kit", "bin.cjs");

async function sqlFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
}

// drizzle-kit reads `--out` relative to its working directory and, given a path it can't
// open, prints the error and still exits 0. So the copy lives inside the package.
async function generateAgainstCopy(): Promise<{
  written: { file: string; sql: string }[];
  stdout: string;
}> {
  const out = await mkdtemp(join(packageDir, "node_modules", ".helpos-migrations-"));
  try {
    await cp(migrationsDir, out, { recursive: true });
    const before = new Set(await sqlFiles(out));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        drizzleKit,
        "generate",
        "--dialect",
        drizzleConfig.dialect,
        "--schema",
        String(drizzleConfig.schema),
        "--out",
        relative(packageDir, out),
      ],
      { cwd: packageDir, timeout: 60_000 },
    );
    const files = (await sqlFiles(out)).filter((file) => !before.has(file));
    const written = await Promise.all(
      files.map(async (file) => ({ file, sql: await readFile(join(out, file), "utf8") })),
    );
    return { written, stdout };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

describe("migrations and the schema", () => {
  it("agree: drizzle-kit generate finds nothing to write", async () => {
    const { written, stdout } = await generateAgainstCopy();
    expect(written).toEqual([]);
    expect(stdout).toContain("No schema changes");
  }, 90_000);
});

let testDb: TestDatabase;
let owner: postgres.Sql;
let jobs: postgres.Sql;

describe("migrating a database that is already migrated", () => {
  beforeAll(async () => {
    testDb = await startTestDatabase();
    owner = postgres(testDb.ownerUrl, { max: 1, onnotice: () => {} });
    jobs = postgres(testDb.jobsUrl, { max: 1, onnotice: () => {} });
  }, 120_000);

  afterAll(async () => {
    await owner?.end({ timeout: 5 });
    await jobs?.end({ timeout: 5 });
    await testDb?.stop();
  });

  async function fingerprint(): Promise<string[]> {
    const catalog = await owner<{ line: string }[]>`
      select line from (
        select 'column ' || c.table_schema || '.' || c.table_name || '.' || c.column_name || ' '
          || c.data_type || ' null=' || c.is_nullable || ' default=' || coalesce(c.column_default, '')
          as line
        from information_schema.columns c
        where c.table_schema in ('public', 'auth', 'jobs_api', 'pgboss')
        union all
        select 'constraint ' || n.nspname || '.' || k.conrelid::regclass::text || ' ' || k.conname
          || ' ' || pg_get_constraintdef(k.oid)
        from pg_constraint k join pg_namespace n on n.oid = k.connamespace
        where n.nspname in ('public', 'auth', 'jobs_api', 'pgboss')
        union all
        select 'index ' || indexdef from pg_indexes
        where schemaname in ('public', 'auth', 'jobs_api', 'pgboss')
        union all
        select 'policy ' || schemaname || '.' || tablename || ' ' || policyname || ' ' || cmd
          || ' roles=' || roles::text || ' using=' || coalesce(qual, '')
          || ' check=' || coalesce(with_check, '')
        from pg_policies
        where schemaname in ('public', 'auth', 'jobs_api', 'pgboss')
        union all
        select 'trigger ' || pg_get_triggerdef(t.oid)
        from pg_trigger t where not t.tgisinternal
        union all
        select 'function ' || pg_get_functiondef(p.oid)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'auth', 'jobs_api', 'pgboss') and p.prokind in ('f', 'p')
          and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
        union all
        select 'relation ' || n.nspname || '.' || c.relname || ' kind=' || c.relkind::text
          || ' owner=' || pg_get_userbyid(c.relowner) || ' rls=' || c.relrowsecurity
          || ' forced=' || c.relforcerowsecurity || ' acl=' || coalesce(c.relacl::text, '')
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'auth', 'jobs_api', 'pgboss')
          and c.relkind in ('r', 'p', 'v', 'm', 'S')
        union all
        select 'column-acl ' || c.relname || '.' || a.attname || ' ' || a.attacl::text
        from pg_attribute a join pg_class c on c.oid = a.attrelid
          join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'auth', 'jobs_api', 'pgboss') and a.attacl is not null
        union all
        select 'function-acl ' || p.oid::regprocedure::text || ' ' || coalesce(p.proacl::text, '')
          || ' owner=' || pg_get_userbyid(p.proowner)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'auth', 'jobs_api', 'pgboss')
        union all
        select 'schema ' || nspname || ' owner=' || pg_get_userbyid(nspowner)
          || ' acl=' || coalesce(nspacl::text, '')
        from pg_namespace where nspname in ('public', 'auth', 'jobs_api', 'pgboss')
        union all
        select 'applied-migration ' || hash || ' ' || created_at
        from drizzle.__drizzle_migrations
      ) as everything
      order by line`;
    const pgboss = await jobs<{ line: string }[]>`
      select 'pgboss-version ' || version || ' ' || coalesce(cron_on::text, '') as line
      from pgboss.version
      union all
      select 'pgboss-queue ' || name || ' ' || policy from pgboss.queue
      order by line`;
    return [...catalog, ...pgboss].map((row) => row.line);
  }

  it("changes nothing when runMigrations and installJobs run again", async () => {
    const before = await fingerprint();
    expect(before.some((line) => line.startsWith("applied-migration "))).toBe(true);
    expect(before.some((line) => line.includes("jobs_api.app_enqueue"))).toBe(true);

    await runMigrations(testDb.ownerUrl);
    await installJobs(testDb.jobsUrl);

    expect(await fingerprint()).toEqual(before);
  });
});
