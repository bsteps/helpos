-- Runs once, as the Postgres superuser, when the dev/test database is first created.
-- ADR 0003: migrations run as an owner role; the app connects as a role WITHOUT BYPASSRLS,
-- so row-level security always applies to app queries.
-- These passwords are for local development and tests only.

CREATE ROLE helpos_owner LOGIN PASSWORD 'helpos_owner' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE helpos_app LOGIN PASSWORD 'helpos_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
-- ADR 0009: users span tenants, so they live in the `auth` schema, which only this role can use.
-- The app role gets no privileges there. Migrations create the schema and grant access to it.
CREATE ROLE helpos_auth LOGIN PASSWORD 'helpos_auth' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

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
