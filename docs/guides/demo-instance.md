# Demo instance for design partners

One small instance that design partners can try: they forward their support mail to it and see AI drafts in the inbox. It runs on **any VPS with Docker**. Nothing in it is tied to a hosting vendor.

Everything lives in [`deploy/demo/`](../../deploy/demo/):

| File                         | What it does                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `compose.yaml`               | Postgres 17 + pgvector, migrations, the server (API, worker, dashboard), Caddy, backups |
| `Caddyfile`                  | HTTPS for your domain, with certificates from Let's Encrypt, renewed automatically      |
| `postgres-init.sh`           | Creates the database roles on first start, with the passwords from `.env`               |
| `backup.sh`                  | A daily dump of the whole database into `deploy/demo/backups/`, keeping the newest 14   |
| `cloudflare-email-worker.js` | Forwards inbound mail to the webhook (the one inbound provider)                         |
| `.env.example`               | Every setting. Copy it to `.env`, which is never committed                              |

## Shadow mode is always on

On the demo, **no reply ever reaches a real customer.** Every approved reply goes to the workspace's shadow recipient (the owner, unless changed), with a banner that names the customer it would have gone to.

`compose.yaml` sets `HELPOS_ALLOW_SHADOW_MODE_OFF: "false"` on the server itself. It's a fixed value, not read from `.env`, so nothing in `.env` can unlock it. Turning shadow mode off through the API then fails with `409 shadow_mode_locked`. CI checks this on every PR (`pnpm demo:check`) by rendering the compose file with a `.env` that tries to turn it off.

## Deploy

You need a VPS with Docker and Compose v2, ports 80 and 443 open, and a domain whose DNS points at it.

```bash
git clone https://github.com/bsteps/helpos.git && cd helpos/deploy/demo
cp .env.example .env
# Replace every value in .env. Make each secret with: openssl rand -hex 32
docker compose up -d --build
docker compose ps        # all running, "migrate" exited with 0
curl https://<your-domain>/health
```

Postgres has no public port. Only Caddy listens on the internet.

To update later: `git pull && docker compose up -d --build`. Migrations run on every start, before the server.

### Inbound mail

The server receives mail at `POST https://<your-domain>/v1/inbound/email`. The body is the raw email, sent with `Authorization: Bearer <HELPOS_INBOUND_SECRET>`. The demo uses **Cloudflare Email Routing** for this, because it's free and only needs the domain's DNS on Cloudflare:

1. In Cloudflare, enable Email Routing for the domain (it adds the MX records).
2. Create a Worker from [`cloudflare-email-worker.js`](../../deploy/demo/cloudflare-email-worker.js), and give it two secrets: `HELPOS_INBOUND_URL` (`https://<your-domain>/v1/inbound/email`) and `HELPOS_INBOUND_SECRET` (same value as in `.env`).
3. Email Routing → Routing rules → **Catch-all** → action "Send to a Worker" → that Worker.

Any provider that can POST the raw email works the same way. To move away from Cloudflare, only that Worker changes.

## Add a design-partner workspace

```bash
cd deploy/demo
docker compose exec server node src/cli/init.ts \
  --workspace "Acme" --mailbox support@acme.com --owner jane@acme.com
```

- `--mailbox` is the partner's **own** support address. A forwarded email still has it in `To`, and that's how the email finds its workspace.
- `--owner` is the partner. They become the shadow recipient, so the drafts they approve come back to them, never to their customer.
- It prints a one-time link (valid 24 hours) where the owner sets their password. Send it only to them.

Then the partner sets up their support inbox (Gmail, Outlook, Google Groups…) to **auto-forward** to any address at your demo domain, e.g. `acme@<your-domain>`. Most providers first send a confirmation email to that address. It arrives as a ticket in their inbox, with the confirmation link in it.

Done: a customer emails `support@acme.com`, the copy lands in the demo, a draft appears in the inbox, and the partner can approve it.

## Backups

The `backup` service writes `deploy/demo/backups/helpos-<time>.dump` (a compressed `pg_dump`) when it starts and then every 24 hours, and keeps the newest 14. The files are readable by root only. Check them with `ls deploy/demo/backups` and `docker compose logs backup`.

They are on the same disk as the database, so **copy them off the VPS** too (for example a nightly `rsync` or `rclone` from cron).

Restore into an empty instance. A dump holds the data but not the database passwords, so restore with the **same `.env`** it was made with:

```bash
cd deploy/demo
docker compose down -v && docker compose up -d --wait postgres
sudo cat backups/helpos-<time>.dump | docker compose exec -T postgres   pg_restore -U postgres -d helpos --clean --if-exists --exit-on-error
docker compose up -d
```

CI runs exactly these steps on every PR (`scripts/smoke-demo.sh`) and checks that the data came back.

## Wipe it

Everything: all workspaces, tickets, users and uploaded files. This cannot be undone.

```bash
cd deploy/demo
docker compose down -v          # removes containers and the database, files and certificate volumes
sudo rm -rf backups/            # the dumps hold the same data
docker compose up -d --build    # a fresh, empty instance, if you want one
```

Also remove off-site backup copies, and ask partners to turn off their forwarding. Deleting a single workspace isn't built yet. To remove one partner's data, wipe the instance and re-add the other partners.

## Manual steps (not in the repo)

These need someone with the accounts. The repo can't do them:

1. **Rent a VPS** with Docker and Compose v2 (2 GB RAM is enough), and open ports 80 and 443.
2. **Pick a domain** and point its A (and AAAA) record at the VPS.
3. **Move the domain's DNS to Cloudflare** (or another inbound provider) and set up Email Routing and the Worker as described above.
4. **Get an SMTP account** for outbound mail (shadowed replies and notices) and put it in `HELPOS_SMTP_URL`. Set up SPF/DKIM for the sending domain, so the mail doesn't land in spam.
5. **Get an AI API key** for `AI_API_KEY`.
6. **Fill in `.env`** on the VPS with fresh secrets, then `docker compose up -d --build`.
7. **Set up off-site backup copies** from `deploy/demo/backups/`.
8. For each design partner: run the workspace command above, send them the password link, and help them set up forwarding.
