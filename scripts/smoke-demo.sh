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
dc exec -T server node src/cli/init.ts   --workspace "Smoke" --mailbox acme@demo.example.test --owner partner@acme.test

# A customer's email, auto-forwarded by the partner's own inbox: it says To: support@acme.test,
# and the forwarding added its own Delivered-To lower down.
forwarded="$(mktemp)"
{ printf 'Delivered-To: support@acme.test
'; cat ../../fixtures/email/plain.eml; } >"$forwarded"

# Runs the real Cloudflare worker code inside the server container. Prints the webhook's status,
# or "rejected" when the worker bounced the email. $1: envelope recipient, $2: worker or direct.
deliver() {
  dc exec -T -e TO="$1" -e MODE="$2" server node --input-type=module -e '
    const worker = await import("/app/deploy/demo/cloudflare-email-worker.mjs");
    const url = "http://127.0.0.1:3000/v1/inbound/email";
    const secret = process.env.HELPOS_INBOUND_SECRET;
    const raw = new Uint8Array(await new Response(process.stdin).arrayBuffer());
    if (process.env.MODE === "direct") {
      const r = await fetch(url, { method: "POST", body: raw,
        headers: { authorization: `Bearer ${secret}`, "content-type": "message/rfc822" } });
      process.stdout.write(String(r.status));
    } else {
      let status = "";
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (...args) => { const r = await realFetch(...args); status = String(r.status); return r; };
      const message = { to: process.env.TO, raw: new Blob([raw]).stream(), setReject: () => { status = "rejected"; } };
      await worker.default.email(message, { HELPOS_INBOUND_URL: url, HELPOS_INBOUND_SECRET: secret });
      process.stdout.write(status);
    }
  ' <"$forwarded"
}
expect() {
  if [ "$1" != "$2" ]; then
    echo "$3: got '$1', expected '$2'" >&2
    dc logs server >&2
    exit 1
  fi
}
# Without the worker, nothing in the forwarded email names the demo mailbox.
expect "$(deliver acme@demo.example.test direct)" 404 "forwarded email posted directly"
expect "$(deliver acme@demo.example.test worker)" 201 "forwarded email through the worker"
expect "$(deliver nobody@demo.example.test worker)" rejected "email to an unknown address"
rm -f "$forwarded"

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
stamp="$(basename "$dump" .dump)"
count_files() { dc exec -T server sh -c 'find /data/files -type f | wc -l' | tr -d ' '; }
files_before="$(count_files)"
expect "$([ "$files_before" -gt 0 ] && echo yes)" yes "stored files before the backup"

# Restore with the commands in docs/guides/demo-instance.md: wipe, fresh Postgres, load the dump,
# unpack the files. The backups are read through the backup container (on the host they're root's).
dc exec -T backup sh -c "cat /backups/$stamp.dump" >"$env_file.dump"
dc exec -T backup sh -c "cat /backups/$stamp.files.tar.gz" >"$env_file.files"
dc down -v
dc up -d --wait postgres
dc exec -T postgres pg_restore -U postgres -d helpos --clean --if-exists --exit-on-error <"$env_file.dump"
dc run --rm -T --no-deps --user root server sh -c "tar -xzpf - -C /data/files" <"$env_file.files"
rm -f "$env_file.dump" "$env_file.files"
dc up -d --wait server backup
expect "$(count_files)" "$files_before" "stored files after the restore"

tickets="$(dc exec -T postgres psql -tA -U postgres -d helpos -c 'select count(*) from tickets')"
if [ "$tickets" != "1" ]; then
  echo "after restoring, expected 1 ticket, found '$tickets'" >&2
  exit 1
fi
echo "demo smoke test passed: workspace created, email stored, database and files backed up and restored"
