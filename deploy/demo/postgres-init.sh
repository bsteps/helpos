#!/bin/sh
# Runs once, when the demo database is first created. Same roles and schemas as
# docker/postgres/init.sql (the reference), but with the passwords from .env.
# psql's :'var' quotes each password, so no character in it can break the SQL.
set -eu
psql -v ON_ERROR_STOP=1 -U postgres \
  -v owner_pw="$HELPOS_OWNER_DB_PASSWORD" -v app_pw="$HELPOS_APP_DB_PASSWORD" \
  -v auth_pw="$HELPOS_AUTH_DB_PASSWORD" -v jobs_pw="$HELPOS_JOBS_DB_PASSWORD" <<'SQL'
CREATE ROLE helpos_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE helpos_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE helpos_auth LOGIN PASSWORD :'auth_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE helpos_jobs LOGIN PASSWORD :'jobs_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE DATABASE helpos OWNER helpos_owner;
\connect helpos
CREATE EXTENSION IF NOT EXISTS vector;
ALTER SCHEMA public OWNER TO helpos_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO helpos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE helpos_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO helpos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE helpos_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO helpos_app;
CREATE SCHEMA pgboss AUTHORIZATION helpos_jobs;
REVOKE ALL ON SCHEMA pgboss FROM PUBLIC;
CREATE SCHEMA jobs_api AUTHORIZATION helpos_jobs;
REVOKE ALL ON SCHEMA jobs_api FROM PUBLIC;
GRANT USAGE ON SCHEMA jobs_api TO helpos_app;
SQL
