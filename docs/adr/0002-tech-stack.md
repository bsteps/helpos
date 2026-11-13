# 0002. Tech stack: one TypeScript/Node image + Postgres

- Status: Accepted
- Date: 2026-11-06
- Superseded in part by: [ADR 0012](0012-no-help-center.md) (the help center row)

## Context

HelpOS must be self-hostable **free or cheaply on any infrastructure** (any VPS, AWS, GCP, Azure, Oracle free tier, PaaS, local machine), with no lock-in to one vendor. It also has to be fast, secure and scalable, easy for contributors, and agent-native.

## Decision

| Layer          | Choice                                                                   | Why                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Language       | TypeScript everywhere                                                    | One language for the widget, dashboard, API, SDK and MCP. Largest contributor pool, best AI SDKs, and coding agents write it very well |
| Runtime        | Node.js 24 in **one Docker image** (`web` and `worker` roles)            | Runs on every host. One image means one thing to test. Self-host = `docker compose up`                                                 |
| API            | Hono + Zod + OpenAPI                                                     | Small and fast, built on standard web APIs. The OpenAPI spec generates the SDK and MCP tools                                           |
| API-first      | The dashboard uses **only the public API**                               | Agents can do everything humans can. This is what makes the product agent-native                                                       |
| Database       | PostgreSQL + Drizzle ORM                                                 | Row-level security, transactions, full-text search and pgvector. Available everywhere                                                  |
| Jobs           | pg-boss (queue inside Postgres)                                          | No Redis needed to self-host                                                                                                           |
| Realtime       | WebSockets behind a `Broadcaster` interface                              | In-process + LISTEN/NOTIFY at first, Redis/NATS adapter when scaling out                                                               |
| Search         | Postgres FTS + pgvector behind a `SearchProvider` interface              | Good enough now; Meilisearch/Typesense can be added later without rewrites                                                             |
| Files          | S3-compatible adapter (S3, R2, MinIO, local disk)                        | Works on any host. Raw email MIME is stored here                                                                                       |
| Email          | Provider/SMTP outbound; provider webhooks + IMAP inbound                 | Self-hosters can use any mailbox. Deliverability is the provider's job                                                                 |
| AI             | Vercel AI SDK, provider-agnostic                                         | Cheap default model, bring your own key, swap models in one line                                                                       |
| Dashboard      | React + Vite SPA, TanStack Router/Query, shadcn/ui                       | Fast, sits behind a login so it doesn't need SSR. Optimistic updates                                                                   |
| Help center    | Server-rendered with Hono JSX + CDN cache                                | SEO and near-instant pages. Dropped by [ADR 0012](0012-no-help-center.md)                                                              |
| Widget         | ≤ 20 KB web-component loader; chat UI in a sandboxed iframe (ADR 0004)   | Never slows customers' sites                                                                                                           |
| Human auth     | Better Auth (sessions only)                                              | Open source, runs inside our app                                                                                                       |
| Agent/API auth | **Our own** scoped, hashed, prefixed, revocable tokens                   | Core to agent-first, and Better Auth's API-key plugin has a CVE history                                                                |
| Tooling        | pnpm 12 (pinned), Turborepo, Biome, Vitest, Playwright, **TypeScript 6** | TS 7 has no stable JS API until 7.1, which breaks type-aware tooling. Move to 7 once 7.1 ships                                         |

**Not supported:** shared hosting (cPanel/GoDaddy). It can't run long-lived Node processes or Postgres.
**Minimum self-host:** 2 GB RAM. A 1 GB "small mode" is experimental.

## Rejected

- **Cloudflare Workers + D1 as the primary target.** The free tier's 10 ms CPU limit breaks password hashing and email parsing. D1 runs one query at a time with a 10 GB cap, and supporting it alongside Docker doubles every feature.
- **SQLite only.** Weak for multi-tenant hosting and has no RLS.
- **Next.js.** Heavier than a dashboard behind a login needs.
- **Go / Elixir / Rails.** Two languages, or a smaller contributor pool and heavier self-hosting.
- **Redis as a required dependency.** One more thing for self-hosters to run.

## Consequences

- Every host that runs Docker can run HelpOS. Scaling means adding machines (separate web/worker nodes, Postgres replicas), not rewriting.
- Swappable pieces (search, realtime, storage, email, AI) sit behind small interfaces, so we can scale up without vendor lock-in.
