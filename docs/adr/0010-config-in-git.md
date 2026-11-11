# 0010. Config, knowledge and policies in git

- Status: Accepted
- Date: 2026-11-07

## Context

"Your helpdesk's config, knowledge and policies live in git as markdown" is one of our differentiators. Teams can review a policy change in a pull request, roll it back with `git revert`, and let a coding agent edit it like any other file.

Building the sync can wait until after the MVP (roadmap "Wedge" set), but the data model can't. If MVP tables like knowledge sources (#61) assume the app is the only writer, adding git later means migrating every row.

Constraints from earlier ADRs:

- Tenant data is read only through `withTenant()` under RLS (ADR 0003, 0009). A git repo has no RLS.
- Imported content is data, never instructions. Policies decide what agents may do, and write actions are off by default (ADR 0004).
- Secrets use envelope encryption (ADR 0004).
- Job payloads carry IDs only (ADR 0009 §2).

## Decision

### 1. What can live in git

| Kind               | Folder          | Example                                      | Treated as                     |
| ------------------ | --------------- | -------------------------------------------- | ------------------------------ |
| Knowledge articles | `knowledge/`    | `knowledge/billing/refunds.md`               | **Data** (quoted to the AI)    |
| Saved replies      | `replies/`      | `replies/password-reset.md`                  | Data (templates a human sends) |
| AI instructions    | `instructions/` | `instructions/tone.md`                       | Tenant config                  |
| Agent policies     | `policies/`     | `policies/refunds.md` (thresholds, approval) | Tenant config                  |

Each file is markdown with YAML frontmatter (`id`, `kind`, `version` and kind-specific fields), validated by a Zod schema per kind. The file body is the content.

**Never in git:** conversations, messages, customers, audit log, memberships, tokens and any secret. These are operational data or credentials, not config.

### 2. The database is the runtime source of truth

The app never reads git when it handles a request or runs an agent. It reads the database, under RLS, as always. Git is an **optional authoring source** that an import job copies into the database.

### 3. One owner per item, one-way sync

- Every importable row has `managed_by` (`app` or `git`) and, when it's `git`, `source_path` and `source_commit`.
- A workspace that connects a repo picks, **per kind**, whether that kind is managed in git. Rows of that kind then have `managed_by = 'git'`.
- **Sync goes one way: git → database.** The API rejects writes to a git-managed row with `409` and a hint to change the file instead. The UI shows these rows read-only, with a link to the file.
- **Later (built with sync):** editing a git-managed item in the UI opens a pull request with the change. Non-technical teammates can still propose edits, a developer merges them, and git stays the only owner. This needs write access, so it is an opt-in on the repo connection.
- No two-way sync, so there are no merge conflicts to resolve. The only "conflict" is a file that fails validation, and section 4 handles it.
- Moving a kind back to `app` keeps the current rows and clears `source_*`. An export endpoint writes app-managed items as files in the same layout, so a team can move into git without retyping.

### 4. Import

- Triggered by a push webhook (signed, per ADR 0004) or a manual "sync now". It enqueues a tenant job with `{tenantId, integrationId, commitSha}`, IDs only.
- The job fetches that exact commit, validates **every** file, and applies the whole set in one `withTenant()` transaction: create, update, and delete rows whose file is gone. If any file fails, nothing is applied and the error (file, line, reason) is shown and audit-logged. The last good commit stays live.
- It's idempotent on `commitSha`. An older commit than the one already applied is ignored, so out-of-order webhooks are harmless.
- Every import is audit-logged with the commit SHA and the commit author. Each changed row's audit event points at that import.
- Knowledge files then go through the normal ingestion path (#61): chunk, embed, store in `knowledge_chunks`.

### 5. Policies from git can't bypass approval

Push access to a repo is not the same as admin rights in the workspace. A policy import that **loosens** anything (enables a write action, raises a threshold or cap, removes an approval step) is staged and takes effect only after an admin approves it in the app. The approval goes through the normal signed-approval path. Tightening changes apply right away. Policy files still can't switch the kill switch off.

### 6. Prompt injection

- Knowledge and saved replies are data, the same as imported web pages: quoted to the model, never merged into its instructions (ADR 0004).
- `instructions/` files are tenant config, the same as instructions typed into the UI. They are trusted exactly as much as a UI edit would be, no more.
- Frontmatter can't set a field the API doesn't let a user set.

### 7. Tenant isolation and secrets

- A repo connection is a tenant `integrations` row. Its access token (a deploy key or a GitHub App installation) is envelope-encrypted, and read-only access is enough unless "propose edits as pull requests" is turned on.
- One repo (optionally with a subfolder) belongs to one workspace. Every imported row carries `tenant_id` under RLS, like any other row.
- Files never hold secrets. A policy that needs one refers to an integration by name. The importer rejects files that match secret-scanning patterns, so a key pushed by mistake never reaches the database.
- Repo fetches use the SSRF-safe fetch (ADR 0004). Self-hosters can point at any git host over HTTPS.

### 8. What the MVP must do now

Only the data model. No sync code.

- Every table holding one of the four kinds (knowledge sources from #61 first) has `managed_by text not null default 'app'`, `source_path text null` and `source_commit text null`.
- Each item has a stable, tenant-unique slug (`UNIQUE (tenant_id, slug)`, ADR 0009 §7) that can map to a file path.
- Knowledge source `kind` is an extensible enum, so `git` can be added later without changing the table's shape.

## Rejected

- **Git as the runtime store** (reading the repo on each request). No RLS, slow, and the app breaks when the git host is down.
- **Two-way sync.** Every edit risks a merge conflict between the UI and a branch, and the UI would need to commit on the user's behalf. One owner per item is simpler and easy to reason about.
- **Database only, with export.** It loses review, revert and agent-editable files, which is the differentiator.
- **Applying valid files and skipping broken ones.** A half-applied policy set is worse than the previous complete one.

## Consequences

- Teams that never connect a repo see no difference. Everything defaults to `managed_by = 'app'`.
- Git-managed items can't be saved directly in the UI; the file is where they change. Until "propose edits as pull requests" ships, non-technical teammates can't edit them, so teams with non-technical editors should keep those kinds managed in the app.
- Loosening a policy needs a PR **and** an in-app approval. That's slower, and it's the price of not letting repo access become admin access.
- The tests are written with the implementation (roadmap Wedge set): `import applies all files or none`, `import ignores an older commit`, `API rejects writes to git-managed rows`, `loosening policy import waits for approval`, `importer rejects a file with a secret`, a leak-suite case `import for tenant A writes no rows in B`, and an eval case `instructions hidden in a git knowledge file are not followed`.
