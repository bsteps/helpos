# AI context layer: research notes

Research notes moved from issue #95. They're background for knowledge, retrieval and connector work. [docs/vision.md](../vision.md) and [docs/roadmap.md](../roadmap.md) decide direction; where these notes disagree, the vision wins.

> **Partly superseded by the [vision](https://github.com/bsteps/helpos/blob/main/docs/vision.md) (roadmap v5, #164).** HelpOS doesn't read customers' code, open fix PRs or build per-tool connectors. Section 4 and the old order in section 7 are replaced below. Sections 1–3, 5 and 6 remain useful research.

Reference notes, not a task. This collects the research and decisions from #61 (PR #89) about how the AI gets its context across the whole product, so we can pick pieces up when their roadmap item comes up. Decisions that stick go into ADRs; link them here.

Two independent research passes (Nov 2026, web sources at the bottom) agreed on the direction below. Vendor numbers are self-reported: treat them as directional.

## 1. Retrieval: one method per kind of data

| Data                               | How to search it                                                                                                                                                                                         | Notes                                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Help articles, docs, website pages | Hybrid: Postgres full-text (per-language config, `simple` + `unaccent` fallback, trigram/bigram for CJK) + multilingual vectors, merged with RRF, then an optional cross-encoder reranker on the top ~40 | Plain vector search isn't enough. Anthropic: hybrid + rerank cut failed retrievals ~67%. Prefix chunks with title and heading path. Fill a token budget (~3–5k), not a fixed top-k. |
| Past conversations                 | Separate index: embed the problem statement and the resolution, not the whole thread                                                                                                                     | Used for "answered before", duplicate conversations (#71) and affected customers. Kept apart so internal chatter is never cited to customers.                                       |
| GitHub issues and PRs              | Hybrid search on title/body + structured filters (state, labels, linked conversations)                                                                                                                   | Mostly metadata.                                                                                                                                                                    |
| Code                               | Agentic search (grep, glob, read files) in a sandboxed shallow clone. **No code embedding index**                                                                                                        | Claude Code dropped its vector index for this. Index goes stale on every commit and chunking breaks code. _Historical: HelpOS doesn't search customer code._                        |
| Relationships                      | Plain SQL over our own tables: customer → conversation → issue → PR → release → article                                                                                                                  | This is the useful "graph". **No GraphRAG**: 100×+ indexing cost, loses on single-hop questions, which support mostly is.                                                           |

Models (check current leaderboards before choosing):

- Embeddings, 1024 dims, multilingual: Qwen3-Embedding-0.6B (Apache, Ollama), BGE-M3, Harrier-0.6B (MIT), EmbeddingGemma; hosted Voyage-4-lite, Cohere embed-v4. OpenAI text-embedding-3-small is weak on non-English.
- Rerankers: Qwen3-Reranker-0.6B, bge-reranker-v2-m3 (self-host), Cohere Rerank (hosted). Jina v3/v5 and zerank are non-commercial licences.
- pgvector ≥ 0.8.3. Exact scan below ~20k chunks per tenant; consider `halfvec(1024)` and per-tenant partial HNSW for big tenants.

## 2. Runtime: two paths, one tool layer

- **Customer-facing reply:** a fixed pipeline (condense query → retrieve → rerank → draft → check). Fast (ADR 0006), cheap, eval-able. Fin, Sierra and Decagon all constrain this path.
- **Back-office work:** an agent loop with tools in the background worker: investigate a conversation cluster, write the bug brief, look things up. Read-only tools by default; any write goes through the policy layer (#13) and the audit log.
- **One tool and retrieval layer serves both, and is exposed over the API and MCP (#19).** Anything our AI can do, an outside agent can do. Don't build a general agent framework; the AI SDK loop is enough.
- **Don't build our own coding agent.** A team's own coding agent fixes code. HelpOS tells customers when the fix ships (#71).

## 3. Grounding (hallucination)

1. Abstain: below a relevance threshold, say "no good source" and hand off. Matters more than prompt wording.
2. Citations checked mechanically: only passages actually offered count (done in #61).
3. Quote-then-answer, quotes checked by string match.
4. A claim check pass against the cited text (later: a small CPU verifier such as LettuceDetect or HHEM-2.1-Open).
5. Policy, not prompts, for dangerous facts: no prices, refunds or dates unless a source says so.
6. Eval sets from real conversations in at least 3 languages, replayed on every model, prompt or retrieval change. North star: the one number in docs/vision.md (fewer decisions, customers just as happy).

## 4. Reading customers' code (superseded)

Not our job. A team's own coding agent reads their code with its own access. HelpOS keeps the waiting list and tells customers when the fix ships (#71). Prompt-injection rule that still applies everywhere: a conversation is untrusted input, never instructions.

## 5. Data sources we haven't planned yet

| Source                                                              | What it gives                                          | Why                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| Error monitoring (Sentry, PostHog, LogRocket, Datadog)              | Stack trace, replay, error count behind a conversation | Strongest bug evidence; groups duplicates by shared error (#71).         |
| Releases and deploys (GitHub releases, changelog, deploy events)    | What changed and when                                  | "Started after Tuesday's deploy"; when to notify that a fix shipped.     |
| Incidents / status (our status page, Statuspage, incident.io)       | A live outage                                          | One answer for 50 conversations.                                         |
| Saved replies / macros (from Zendesk, Help Scout, Intercom imports) | The team's approved best answers                       | Often better than the help center; free with imports.                    |
| Internal notes, runbooks, policies                                  | Refund policy, escalation rules, workarounds           | **Internal only**: never cited to customers or shown in the help center. |
| Billing and CRM (Stripe, HubSpot, Attio)                            | Plan, revenue, owner                                   | Revenue-weighted requests, priority.                                     |
| The customer's own app data, via actions (#13)                      | Account state, flags, last login                       | "Why can't I…?" answers live in the account.                             |
| Community (Discord, Slack Connect, GitHub Discussions, forums)      | Where dev-tool users ask                               | Often bigger than email for many products.                               |
| API reference (OpenAPI spec)                                        | Exact endpoints and params                             | Precise for developer questions.                                         |
| Screenshots in conversations                                        | The error the customer didn't type                     | Already ours; read with a vision model.                                  |
| Feedback (CSAT, draft edits, approve/reject)                        | What worked                                            | Teach, evals, gap detection. Capture draft-vs-sent diffs from day one.   |

**Don't build all these connectors.** Sentry, Stripe, Linear, PostHog, HubSpot and Datadog ship MCP servers. Besides exposing MCP (#19), **consume** it: a workspace plugs in MCP servers as read-only tools for the back-office agent, behind policy and audit. We build no per-tool connectors (#174).

## 6. Architecture so connectors and features are easy to add

_Historical: per-tool adapters are replaced by connecting any tool's MCP server through the gate (#174). The one document model below still applies to HelpOS's own knowledge._

The goal: adding a connector is writing one adapter; search, tenancy, citations, budgets, audit and the API come for free.

1. **One connector interface, two capabilities.**
   - `sync`: pulls items into the shared document store (full + incremental via cursor/webhook, keyed by `external_id`).
   - `tools`: live lookups/actions, MCP-shaped (name, input schema, scope).
     A built-in connector and a workspace's MCP server look the same to the agent.
2. **One document model.** Everything indexed becomes a document: connector, kind, external_id, url, title, language, **visibility (public / internal)**, updated_at, metadata → chunks. Connectors only map their data into it.
3. **One links table** for relationships (conversation ↔ issue ↔ PR ↔ release ↔ customer ↔ article). That's the graph.
4. **One tool registry**: scopes, policy check, audit log, per-tenant budget. The same registry backs our agent, the public API and MCP.
5. **Events in, jobs out.** Connectors emit events (deploy, release, incident, issue closed) into the job queue; features subscribe (notify affected customers, re-sync, re-cluster).
6. **Search is a provider per corpus** behind one `search(query, {corpora, visibility, language})` call (the `SearchProvider` from #61 grows into this).
7. Config and knowledge stay compatible with git management (ADR 0010, [ADR 0013](../adr/0013-rules-knowledge-settings-in-git.md)).

## 7. Order (follows docs/roadmap.md)

1. #61: hybrid full-text + optional reranker, abstain threshold, `visibility` (done).
2. #178: no source, no answer, for every agent.
3. #172: knowledge gaps ranked by demand.
4. #176: freshness loop (change events, last-checked dates, staleness flags).
5. #71: waiting lists. No code access.
6. #174: consume any tool's MCP server through the gate, after live outcomes are measured.
7. Teaching goes through the playbook (#167) and the trust ladder (#166).

**Traps to avoid:** GraphRAG; training our own embedding or reranker models; a generic agent builder or workflow DSL; building many connectors before anyone asks; autopilot before approve-rate data.

## Sources

- https://anthropic.com/research/contextual-retrieval
- https://fin.ai/research/how-we-built-a-world-class-reranker-for-fin/
- https://sierra.ai/blog/defense-in-depth-in-the-age-of-agents
- https://decagon.ai/modules/decagon-platform
- https://blog.sentry.io/seer-sentrys-ai-debugger-is-generally-available/
- https://blog.sentry.io/seer-can-now-trigger-cursor-agents-to-fix-your-bugs
- https://arxiv.org/pdf/2503.02922 (GraphRAG-Bench)
- https://academy.dair.ai/papers/is-grep-all-you-need
- https://www.ai.engineer/talks/UM6sFg_jdlE-rag-is-dead-right-kuba-rogut
- https://www.usepylon.com/ai-agents/assist
- https://linear.app/enablement/guide/ai-agents
- https://sentry.zendesk.com/hc/en-us/articles/45107889559963-GitHub-App-Write-Access-FAQ
- https://docs.coderabbit.ai/self-hosted/overview
- https://invariantlabs.ai/blog/mcp-github-vulnerability
- https://amplifying.ai/coding-agents/devin
