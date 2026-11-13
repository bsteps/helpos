# Self-hosting

What your own Postgres and AI settings need before HelpOS will run. Local development needs none of this: `pnpm dev` starts a ready Postgres in Docker.

## Upgrading across the conversation rename (#184)

This change breaks existing API clients. Deploy the server and dashboard together, run migrations 0020 and 0021, and update callers to the new names:

| Before                                          | After                                             |
| ----------------------------------------------- | ------------------------------------------------- |
| `/v1/tickets…`                                  | `/v1/conversations…`                              |
| `tickets:read`, `tickets:write`                 | `conversations:read`, `conversations:write`       |
| `ticketId`, `ticket`, `tickets` in API payloads | `conversationId`, `conversation`, `conversations` |
| `ticket_closed` error code                      | `conversation_closed`                             |
| `/tickets/<id>` dashboard links                 | `/conversations/<id>`                             |

There are no aliases or redirects. For saved links and links in previously sent emails, replace `/tickets/` with `/conversations/`, keeping the same ID.

Migration 0020 renames the tables, columns, constraints and indexes. Migration 0021 renames scopes on stored tokens, so existing token secrets remain valid. Update scope names in scripts that create tokens. It also renames audit action `ticket.closed` to `conversation.closed` and target type `ticket` to `conversation`; free-form audit metadata stays unchanged.

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

The roles and schemas HelpOS expects (owner, app, auth and jobs roles) are set up the same way the dev database is. Run [`docker/postgres/init.sql`](../docker/postgres/init.sql) with `psql` as the superuser. It reads each role's password from `HELPOS_OWNER_DB_PASSWORD`, `HELPOS_APP_DB_PASSWORD`, `HELPOS_AUTH_DB_PASSWORD` and `HELPOS_JOBS_DB_PASSWORD`, and stops if one is unset.

## AI configuration at startup

The server validates chat and embedding settings before it opens services. A nonempty but invalid group stops startup with a message that names the missing or invalid variables, without showing their values. For example, `AI_PROVIDER=openai` requires both `AI_MODEL` and `AI_API_KEY`.

To disable drafting, leave `AI_PROVIDER`, `AI_MODEL`, and `AI_API_KEY` unset or empty. To disable embeddings, leave all four `AI_EMBEDDING_*` variables unset or empty. The development example leaves both groups empty so a fresh checkout starts without provider credentials. To enable drafting, set the provider, model, and key together.

Startup checks configuration structure only. Model availability, rejected credentials, and service outages are handled when a provider call runs.

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

## Demo instance

For a ready Docker Compose deployment (HTTPS, backups, shadow mode locked on), see [the demo instance guide](guides/demo-instance.md).
