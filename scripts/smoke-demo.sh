#!/usr/bin/env bash
# Boots the demo stack (without Caddy: CI has no domain), creates a workspace the way the guide
# says, and sends one email through the inbound webhook. Proves the deployment works end to end
# up to "the email is a ticket". Throwaway passwords, everything removed at the end.
set -euo pipefail
cd "$(dirname "$0")/../deploy/demo"

env_file="$(mktemp)"
project="helpos-demo-smoke"
cleanup() {
  # The dumps belong to root inside the container, so remove them from there.
  docker compose -p "$project" --env-file "$env_file" exec -T backup sh -c "rm -f /backups/helpos-*" >/dev/null 2>&1 || true
  docker compose -p "$project" --env-file "$env_file" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$env_file"
}
trap cleanup EXIT

secret() { openssl rand -hex 32; }
inbound_secret="$(secret)"
{
  echo "HELPOS_DOMAIN=demo.example.test"
  for v in POSTGRES_SUPERUSER_PASSWORD HELPOS_OWNER_DB_PASSWORD HELPOS_APP_DB_PASSWORD \
    HELPOS_AUTH_DB_PASSWORD HELPOS_JOBS_DB_PASSWORD HELPOS_AUTH_SECRET; do
    echo "$v=$(secret)"
  done
  echo "HELPOS_INBOUND_SECRET=$inbound_secret"
  echo "HELPOS_SMTP_URL=smtp://localhost:1" # nothing is sent in this test
} >"$env_file"
dc() { docker compose -p "$project" --env-file "$env_file" "$@"; }

dc up -d --build --wait server backup

# Adding a design-partner workspace, exactly as in docs/guides/demo-instance.md.
dc exec -T server node src/cli/init.ts \
  --workspace "Smoke" --mailbox support@acme.test --owner partner@acme.test

status="$(dc exec -T server node -e '
  const fs = require("node:fs");
  fetch("http://127.0.0.1:3000/v1/inbound/email", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.HELPOS_INBOUND_SECRET}`, "content-type": "message/rfc822" },
    body: fs.readFileSync(0),
  }).then((r) => console.log(r.status));
' <../../fixtures/email/plain.eml)"
if [ "$status" != "201" ]; then
  echo "inbound webhook answered $status, expected 201" >&2
  dc logs server >&2
  exit 1
fi

# The backup service dumps on start. Restart it now, so the dump holds the email above.
dc exec -T backup sh -c "rm -f /backups/helpos-*"
dc restart backup
dump=""
for _ in $(seq 1 30); do
  dump="$(dc exec -T backup sh -c 'ls -1t /backups/helpos-*.dump 2>/dev/null | head -n 1' || true)"
  [ -n "$dump" ] && break
  sleep 2
done
if [ -z "$dump" ]; then
  echo "no backup was written" >&2
  dc logs backup >&2
  exit 1
fi
dump="$(basename "$dump")"

# Restore it exactly as docs/guides/demo-instance.md says: wipe, fresh Postgres, load the dump.
# The dump is read through the backup container: on the host it belongs to root.
dc exec -T backup sh -c "cat /backups/$dump" >"$env_file.dump"
dc down -v
dc up -d --wait postgres
dc exec -T postgres pg_restore -U postgres -d helpos --clean --if-exists --exit-on-error <"$env_file.dump"
rm -f "$env_file.dump"
dc up -d --wait server backup

tickets="$(dc exec -T postgres psql -tA -U postgres -d helpos -c 'select count(*) from tickets')"
if [ "$tickets" != "1" ]; then
  echo "after restoring, expected 1 ticket, found '$tickets'" >&2
  exit 1
fi
echo "demo smoke test passed: workspace created, email stored, backup written and restored"
