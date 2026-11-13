-- Runs once, as the Postgres superuser, when the database is first created: for local dev and
-- tests (docker-compose.yml) and for the demo (deploy/demo/compose.yaml). The single place that
-- creates the roles, schemas and grants.
-- ADR 0003: migrations run as an owner role; the app connects as a role WITHOUT BYPASSRLS,
-- so row-level security always applies to app queries.

-- Each role's password comes from the environment: dev sets the role's own name, the demo
-- reads its .env. An unset one leaves `:'x'` in the SQL, a syntax error, so Postgres refuses to
-- start rather than create a role with a password nobody chose. :'x' quotes the value, so no
-- character in a password can break the SQL.
\getenv owner_password HELPOS_OWNER_DB_PASSWORD
\getenv app_password HELPOS_APP_DB_PASSWORD
\getenv auth_password HELPOS_AUTH_DB_PASSWORD
\getenv jobs_password HELPOS_JOBS_DB_PASSWORD

CREATE ROLE helpos_owner LOGIN PASSWORD :'owner_password' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE helpos_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
-- ADR 0009: users span tenants, so they live in the `auth` schema, which only this role can use.
-- The app role gets no privileges there. Migrations create the schema and grant access to it.
CREATE ROLE helpos_auth LOGIN PASSWORD :'auth_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
-- pg-boss runs as this role and owns its `pgboss` schema. The app and auth roles get
-- no privileges there; the app may only enqueue, through jobs_api.app_enqueue().
CREATE ROLE helpos_jobs LOGIN PASSWORD :'jobs_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

CREATE DATABASE helpos OWNER helpos_owner;

\connect helpos

-- Extensions need a superuser, so they are created here rather than in migrations.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER SCHEMA public OWNER TO helpos_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO helpos_app;

-- Tables created later by the owner (migrations) are usable by the app, but only for data access.
ALTER DEFAULT PRIVILEGES FOR ROLE helpos_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO helpos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE helpos_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO helpos_app;

-- Created here, not by pg-boss, so the jobs role needs no CREATE on the database.
CREATE SCHEMA pgboss AUTHORIZATION helpos_jobs;
REVOKE ALL ON SCHEMA pgboss FROM PUBLIC;
-- Holds only app_enqueue(). A separate schema, so the app needs no USAGE on `pgboss`.
CREATE SCHEMA jobs_api AUTHORIZATION helpos_jobs;
REVOKE ALL ON SCHEMA jobs_api FROM PUBLIC;
GRANT USAGE ON SCHEMA jobs_api TO helpos_app;
