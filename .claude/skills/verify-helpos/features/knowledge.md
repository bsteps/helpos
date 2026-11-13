# Knowledge

Knowledge sources are the pages and notes the AI drafts from. A source is a URL or Markdown, `public` (may be shown to customers) or `internal` (team notes, the default). The worker splits each source into passages and embeds them. When it drafts, it retrieves the best matches and cites them. People manage sources in the Knowledge screen. Agents and scripts use the public API.

## Sub-features

- `kb-list` lists sources with typed `state` (`pending`, `ready`, `failed` with a reason, or `waiting` with a reason and `retryAt`) and `chunkCount`.
- `kb-create` adds a URL or Markdown source, which becomes `ready` once embedded.
- `kb-edit` changes title or visibility at once. A content change re-ingests only that source.
- `kb-reingest` fetches and embeds again.
- `kb-delete` removes a source and its passages.
- `kb-used` shows the source in a draft's `sources` and in the dashboard's `Written from`.

## How to get to it (user POV)

- Dashboard: open **Knowledge** to list, create, edit, re-ingest, or delete a source.
- API: `GET v1/knowledge/sources`, `POST v1/knowledge/sources`, `PATCH v1/knowledge/sources/{id}`, `POST v1/knowledge/sources/{id}/reingest`, `DELETE v1/knowledge/sources/{id}`.
- The effect shows in the dashboard on drafts: `Written from <title>`.

## Driving it with Playwright and api.mjs

Preconditions: baseline. Embeddings on (`doctor.mjs` shows `embeddings ok`). A token with `knowledge:write`: Northwind has none active, so mint one with `pnpm api owner POST v1/tokens '{"name":"verify-kb","scopes":["knowledge:read","knowledge:write"]}'` and use the returned `hos_…` as `<as>`.

- **List.** `pnpm api northwind:triage-bot GET v1/knowledge/sources` lists the seeded sources, all `ready` with `chunkCount` 1 or more.
- **Create.** `pnpm api <hos_token> POST v1/knowledge/sources '{"kind":"markdown","title":"Verify gift wrap","content":"# Gift wrap\n\nGift wrap costs 4 EUR per order.","visibility":"public"}'` returns `201` with `state: { status: "pending" }`, then `ready` within about 10 seconds (local Ollama).
- **Used in a draft.** Deliver an email asking about gift wrap. Its draft's `sources[]` include `Verify gift wrap`, and the dashboard shows it under `Written from`.
- **Edit.** `PATCH v1/knowledge/sources/<id> '{"visibility":"internal"}'` returns `200` at once. `'{"content":"..."}'` returns the source to `pending`, then `ready`.
- **Re-ingest.** `POST v1/knowledge/sources/<id>/reingest` returns `202`.
- **Delete.** `DELETE v1/knowledge/sources/<id>` returns `204`, and the source is gone from the list.
- **Scopes.** `pnpm api northwind:triage-bot POST v1/knowledge/sources ...` returns `403`, because it can only read.

## Gotchas

- Without embeddings, sources stay `pending` and drafts use no knowledge. That is not a failure of this feature. Fix it with `launch.mjs` (Ollama) or embedding settings in `.env`.
- URL sources are fetched through the SSRF guard. `localhost`, private and metadata addresses are refused, so you can't point a URL source at a local test server.
- The database holds 1024-dimension vectors. An embedding model with another size fails ingestion with `expected 1024`.
- Sources with `managedBy: "git"` come from config in git (ADR 0010, [ADR 0013](../../../../docs/adr/0013-rules-knowledge-settings-in-git.md)), and the API may refuse to edit them.
- Delete the sources you created. Seeded ones are counted on by other checks.
