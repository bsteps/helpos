# Self-hosting

What your own Postgres and AI settings need before HelpOS will run. Local development needs none of this: `pnpm dev` starts a ready Postgres in Docker.

## Postgres

You need **Postgres 17** with the **pgvector extension, version 0.8 or newer**. The knowledge base stores passages as `vector(1024)` columns with an HNSW index, and 0.8 is the first version with iterative index scans, which filtered searches rely on.

Migrations run as a normal owner role, not a superuser, so they can't create the extension themselves. Enable it once, as a superuser or from your provider's console, in the HelpOS database, **before the first migration**:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Without it, migrating fails as soon as it reaches the knowledge base tables.

Where to find it:

| Where Postgres runs           | How to enable pgvector                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your own server or VPS        | Install the package (e.g. `postgresql-17-pgvector` on Debian/Ubuntu), or use the `pgvector/pgvector:pg17` Docker image, then run the SQL above as `postgres`. |
| AWS RDS / Aurora              | Supported. Connect as the master user and run the SQL above.                                                                                                  |
| Google Cloud SQL              | Supported. Run the SQL above as a user with the `cloudsqlsuperuser` role.                                                                                     |
| Azure Database for PostgreSQL | Allow `VECTOR` in the `azure.extensions` server parameter, then run the SQL above.                                                                            |
| Supabase                      | Database → Extensions → enable `vector`, or run the SQL above.                                                                                                |

Check the version afterwards:

```sql
SELECT extversion FROM pg_extension WHERE extname = 'vector';  -- must be 0.8.0 or newer
```

To upgrade an older one: `ALTER EXTENSION vector UPDATE;` (after your provider or package offers 0.8+).

The roles and schemas HelpOS expects (owner, app, auth and jobs roles) are set up the same way the dev database is. [`docker/postgres/init.sql`](../docker/postgres/init.sql) is the reference: run its equivalent with your own passwords.

## Dashboard and sign-in

The server serves the dashboard itself, from the same origin as the API, so the session cookie needs no CORS. Build it with `pnpm --filter @helpos/web build` and point the server at the result:

| Variable             | Meaning                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HELPOS_WEB_DIR`     | The built dashboard (`apps/web/dist`). Unset: the server serves only the API.                                                                        |
| `HELPOS_PUBLIC_URL`  | The URL people open the dashboard at, e.g. `https://help.example.com`. Links in emails use it, and browser writes from any other origin are refused. |
| `HELPOS_AUTH_SECRET` | Signs session cookies. At least 32 characters: `openssl rand -hex 32`. Unset: nobody can sign in; agent tokens still work.                           |

Sign-in also needs `HELPOS_DATABASE_AUTH_URL` (the auth role). With an `https` public URL, cookies are marked `Secure`, so serve the dashboard over HTTPS.

There is no sign-up page. `pnpm helpos:init` creates the owner and prints a one-time link, valid for 24 hours, where they set their password. Send it only to the owner. Running `helpos:init` again prints a fresh link (the old one stops working) for as long as the owner has no password.

## Embeddings (knowledge base)

Drafts quote your workspace's own docs. To do that, knowledge sources are split into passages and embedded. Embeddings are configured separately from the chat model, because not every provider offers them: **Anthropic has no embeddings API**, so even if your chat model is Claude you need one of the options below.

Embeddings are optional. When unset, new sources wait in the queue and drafts use no knowledge.

| Variable                | Meaning                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| `AI_EMBEDDING_PROVIDER` | `openai`. Also covers any OpenAI-compatible server.               |
| `AI_EMBEDDING_MODEL`    | Model id. Default `text-embedding-3-small`.                       |
| `AI_EMBEDDING_API_KEY`  | Your key. Required for OpenAI; a local server usually needs none. |
| `AI_EMBEDDING_BASE_URL` | An OpenAI-compatible server instead of OpenAI itself.             |

The model must give **1024-dimension vectors**, because the database column is fixed at that size. A model that returns another size is refused with a clear error. Embedding tokens count toward `HELPOS_AI_DAILY_TOKEN_BUDGET`.

Put these in `.env` (never committed). See [`.env.example`](../.env.example) for all settings.

### Example: OpenAI

```bash
AI_EMBEDDING_PROVIDER=openai
AI_EMBEDDING_MODEL=text-embedding-3-small   # asked for 1024 dimensions
AI_EMBEDDING_API_KEY=sk-...
```

### Example: free, local, with Ollama

```bash
ollama pull mxbai-embed-large
```

```bash
AI_EMBEDDING_PROVIDER=openai
AI_EMBEDDING_BASE_URL=http://localhost:11434/v1
AI_EMBEDDING_MODEL=mxbai-embed-large
# no API key needed
```

If HelpOS runs in Docker and Ollama on the host, use `http://host.docker.internal:11434/v1` instead of `localhost`. `bge-m3` also works.

## GitHub (ticket → issue → "it's fixed")

A workspace owner connects one repo under **Settings → GitHub**, with a fine-grained personal access token that has **Issues: read and write** on that repo. The server stores the token encrypted, so it needs a key:

| Variable                | Meaning                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `HELPOS_ENCRYPTION_KEY` | Encrypts the GitHub token and webhook secrets at rest (AES-256-GCM). 32 bytes as hex or base64: `openssl rand -base64 32`. Unset: no repo can be connected. |
| `HELPOS_GITHUB_API_URL` | The GitHub API. Default `https://api.github.com`; set it for GitHub Enterprise Server.                                                        |

Keep the key safe and don't change it casually: tokens stored under the old key can't be read, and each workspace has to connect its repo again.

After connecting, the dashboard shows a webhook **Payload URL** and **secret** once. In the repo's Settings → Webhooks, add a webhook with those values, content type `application/json`, and only the **Issues** event. When an issue made from a ticket is closed as completed, the ticket gets a "fixed" draft to approve; like every reply, it goes to the shadow recipient while shadow mode is on.

## Demo instance

For a ready Docker Compose deployment (HTTPS, backups, shadow mode locked on), see [the demo instance guide](guides/demo-instance.md).
