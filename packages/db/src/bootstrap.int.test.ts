import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { containerHost } from "./testing.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const run = promisify(execFile);

const composeConfig = z.object({
  services: z.object({
    postgres: z.object({
      environment: z.record(z.string(), z.string()),
      volumes: z.array(z.object({ source: z.string(), target: z.string() })),
    }),
  }),
});

type Setup = { files: { source: string; target: string }[]; environment: Record<string, string> };

/** What a compose file gives its Postgres on first start: the init files and the environment. */
async function composeSetup(composeFile: string, envFile?: string): Promise<Setup> {
  const envArgs = envFile ? ["--env-file", envFile] : [];
  const { stdout } = await run(
    "docker",
    ["compose", "-f", join(repoRoot, composeFile), ...envArgs, "config", "--format", "json"],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  const { postgres: service } = composeConfig.parse(JSON.parse(stdout)).services;
  return {
    files: service.volumes.filter((v) => v.target.startsWith("/docker-entrypoint-initdb.d/")),
    environment: service.environment,
  };
}

// Quotes and semicolons, so a password that isn't quoted properly breaks the SQL.
const demoPasswords = {
  helpos_owner: "owner'pw;1",
  helpos_app: "app'pw;2",
  helpos_auth: "auth'pw;3",
  helpos_jobs: "jobs'pw;4",
};
const demoEnvKeys = {
  helpos_owner: "HELPOS_OWNER_DB_PASSWORD",
  helpos_app: "HELPOS_APP_DB_PASSWORD",
  helpos_auth: "HELPOS_AUTH_DB_PASSWORD",
  helpos_jobs: "HELPOS_JOBS_DB_PASSWORD",
};
const devPasswords = {
  helpos_owner: "helpos_owner",
  helpos_app: "helpos_app",
  helpos_auth: "helpos_auth",
  helpos_jobs: "helpos_jobs",
};

async function demoSetup(): Promise<Setup> {
  const dir = await mkdtemp(join(tmpdir(), "helpos-bootstrap-"));
  try {
    const example = await readFile(join(repoRoot, "deploy/demo/.env.example"), "utf8");
    const overrides = new Map(
      Object.entries(demoEnvKeys).map(([role, key]) => [
        key,
        demoPasswords[role as keyof typeof demoPasswords],
      ]),
    );
    const env = example
      .split("\n")
      .map((line) => {
        const key = line.split("=")[0] ?? "";
        const password = overrides.get(key);
        return password === undefined ? line : `${key}=${password}`;
      })
      .join("\n");
    const envFile = join(dir, ".env");
    await writeFile(envFile, env);
    return await composeSetup("deploy/demo/compose.yaml", envFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Postgres as the compose file starts it the first time, as the `postgres` superuser. */
function postgresFor({ files, environment }: Setup): PostgreSqlContainer {
  return new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withUsername("postgres")
    .withDatabase("postgres")
    .withPassword(environment.POSTGRES_PASSWORD ?? "postgres")
    .withEnvironment(environment)
    .withCopyFilesToContainer(files);
}

const start = (setup: Setup) => postgresFor(setup).start();

function connect(
  container: StartedPostgreSqlContainer,
  username: string,
  password: string,
): postgres.Sql {
  return postgres({
    host: containerHost(container),
    port: container.getPort(),
    database: "helpos",
    username,
    password,
    max: 1,
    onnotice: () => {},
  });
}

/** The roles, the database, its extensions, schemas and grants that bootstrap leaves behind. */
async function snapshot(container: StartedPostgreSqlContainer) {
  const sql = connect(container, "postgres", container.getPassword());
  try {
    const roles = await sql<{ name: string; attributes: string; memberOf: string[] }[]>`
      select r.rolname as name,
        concat_ws(' ',
          case when r.rolsuper then 'SUPERUSER' end,
          case when r.rolcreaterole then 'CREATEROLE' end,
          case when r.rolcreatedb then 'CREATEDB' end,
          case when r.rolcanlogin then 'LOGIN' end,
          case when r.rolreplication then 'REPLICATION' end,
          case when r.rolbypassrls then 'BYPASSRLS' end,
          case when not r.rolinherit then 'NOINHERIT' end) as attributes,
        array(select g.rolname from pg_auth_members m join pg_roles g on g.oid = m.roleid
          where m.member = r.oid order by 1)::text[] as "memberOf"
      from pg_roles r where r.rolname !~ '^pg_' order by r.rolname`;
    // A NULL acl means the built-in default, which acldefault() spells out.
    const [database] = await sql<{ owner: string; grants: string[] }[]>`
      select pg_get_userbyid(d.datdba) as owner,
        array(select coalesce(pg_get_userbyid(nullif(a.grantee, 0)), 'PUBLIC') || ' ' || a.privilege_type
          from aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a order by 1)::text[] as grants
      from pg_database d where d.datname = 'helpos'`;
    const extensions = await sql<{ name: string; owner: string }[]>`
      select extname as name, pg_get_userbyid(extowner) as owner from pg_extension order by 1`;
    const schemas = await sql<{ name: string; owner: string; grants: string[] }[]>`
      select n.nspname as name, pg_get_userbyid(n.nspowner) as owner,
        array(select coalesce(pg_get_userbyid(nullif(a.grantee, 0)), 'PUBLIC') || ' ' || a.privilege_type
          from aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a order by 1)::text[] as grants
      from pg_namespace n
      where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' order by 1`;
    const defaultPrivileges = await sql<{ entry: string }[]>`
      select pg_get_userbyid(d.defaclrole) || ' in ' || coalesce(n.nspname, 'any schema')
        || ', on new ' || case d.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences'
          when 'f' then 'functions' when 'T' then 'types' when 'n' then 'schemas' end
        || ': ' || pg_get_userbyid(a.grantee) || ' ' || a.privilege_type as entry
      from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace,
        aclexplode(d.defaclacl) a
      order by 1`;
    return {
      roles: [...roles],
      database,
      extensions: [...extensions],
      schemas: [...schemas],
      defaultPrivileges: defaultPrivileges.map((row) => row.entry),
    };
  } finally {
    await sql.end();
  }
}

async function loginsAs(container: StartedPostgreSqlContainer, passwords: typeof devPasswords) {
  const users: string[] = [];
  for (const [role, password] of Object.entries(passwords)) {
    const sql = connect(container, role, password);
    try {
      const [row] = await sql<{ user: string }[]>`select current_user as user`;
      users.push(row?.user ?? "");
    } finally {
      await sql.end();
    }
  }
  return users;
}

const role = (name: string, attributes = "LOGIN") => ({ name, attributes, memberOf: [] });

// What tenant isolation asks of a fresh database: no HelpOS role can bypass row-level security,
// the app reaches only `public` (data access on what migrations create) and `jobs_api`, and only
// the jobs role reaches `pgboss`. The `auth` schema comes later, with the migrations.
const expected = {
  roles: [
    role("helpos_app"),
    role("helpos_auth"),
    role("helpos_jobs"),
    role("helpos_owner"),
    role("postgres", "SUPERUSER CREATEROLE CREATEDB LOGIN REPLICATION BYPASSRLS"),
  ],
  database: {
    owner: "helpos_owner",
    grants: [
      "PUBLIC CONNECT",
      "PUBLIC TEMPORARY",
      "helpos_owner CONNECT",
      "helpos_owner CREATE",
      "helpos_owner TEMPORARY",
    ],
  },
  extensions: [
    { name: "plpgsql", owner: "postgres" },
    { name: "vector", owner: "postgres" },
  ],
  schemas: [
    {
      name: "jobs_api",
      owner: "helpos_jobs",
      grants: ["helpos_app USAGE", "helpos_jobs CREATE", "helpos_jobs USAGE"],
    },
    { name: "pgboss", owner: "helpos_jobs", grants: ["helpos_jobs CREATE", "helpos_jobs USAGE"] },
    {
      name: "public",
      owner: "helpos_owner",
      grants: ["helpos_app USAGE", "helpos_owner CREATE", "helpos_owner USAGE"],
    },
  ],
  defaultPrivileges: [
    "helpos_owner in public, on new sequences: helpos_app SELECT",
    "helpos_owner in public, on new sequences: helpos_app USAGE",
    "helpos_owner in public, on new tables: helpos_app DELETE",
    "helpos_owner in public, on new tables: helpos_app INSERT",
    "helpos_owner in public, on new tables: helpos_app SELECT",
    "helpos_owner in public, on new tables: helpos_app UPDATE",
  ],
};

describe("Postgres bootstrap", () => {
  let dev: StartedPostgreSqlContainer;
  let demo: StartedPostgreSqlContainer;

  beforeAll(async () => {
    [dev, demo] = await Promise.all([
      composeSetup("docker-compose.yml").then(start),
      demoSetup().then(start),
    ]);
  });

  afterAll(async () => {
    await Promise.all([dev?.stop(), demo?.stop()]);
  });

  it("gives dev and the demo the same roles, schemas and grants", async () => {
    const [devState, demoState] = await Promise.all([snapshot(dev), snapshot(demo)]);
    expect(devState).toEqual(expected);
    expect(demoState).toEqual(expected);
  });

  it("dev roles log in with the dev passwords", async () => {
    expect(await loginsAs(dev, devPasswords)).toEqual(Object.keys(devPasswords));
  });

  it("demo roles log in with the passwords from .env, special characters included", async () => {
    expect(await loginsAs(demo, demoPasswords)).toEqual(Object.keys(demoPasswords));
  });

  it("the demo database fails to start when a password is missing", async () => {
    const { files, environment } = await demoSetup();
    const { HELPOS_APP_DB_PASSWORD: _missing, ...withoutApp } = environment;
    let logs = "";
    const container = postgresFor({ files, environment: withoutApp }).withLogConsumer((stream) =>
      stream.on("data", (chunk) => {
        logs += String(chunk);
      }),
    );
    await expect(container.start()).rejects.toThrow();
    // The unset password stays in the SQL as `:'app_password'`, which Postgres rejects.
    expect(logs).toContain(`syntax error at or near ":"`);
  });
});
