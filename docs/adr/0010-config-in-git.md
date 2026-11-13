# 0010. Rules, knowledge and settings in git

- Status: Accepted
- Date: 2026-11-07

## Context

Teams can keep rules, knowledge and settings in git, review changes in pull requests, roll them back, and let an agent edit them. The database remains the runtime store so requests have tenant isolation and do not depend on a git host being available.

## Decision

### 1. Four kinds can live in git

| Kind          | Folder       | Example                     | Treated as                                         |
| ------------- | ------------ | --------------------------- | -------------------------------------------------- |
| Knowledge     | `knowledge/` | `knowledge/refunds.md`      | **Data**, quoted to the AI                         |
| Saved replies | `replies/`   | `replies/password-reset.md` | **Data**, templates for replies                    |
| Rules         | `rules/`     | `rules/tone.md`             | Workspace config, the playbook agents follow       |
| Settings      | `settings/`  | `settings/channels.md`      | Workspace config, values the API lets a person set |

Each file is Markdown with YAML frontmatter (`id`, `kind`, `version` and fields for its kind), validated by a Zod schema per kind. The body is the content.

Conversations, messages, customers, audit logs, memberships, tokens, secrets, trust levels and kill switches stay out of git. Trust is earned from outcomes and accepted by a person in the desk ([ADR 0011](0011-the-gate.md)). A file cannot grant it or turn a kill switch off.

### 2. The database is the runtime source of truth

Requests and agents read the database under RLS, through `withTenant()` ([ADR 0003](0003-tenant-isolation.md)). Git is an optional authoring source. An import job copies validated content into the database, so a git outage cannot stop support work.

### 3. One owner per item, one-way sync

- Every importable row has `managed_by` (`app` or `git`) and, when it is `git`, `source_path` and `source_commit`.
- A workspace chooses per kind whether git manages its items.
- Sync goes one way, from git to the database. The API rejects writes to a git-managed item with `409` and a hint to change the file. A frontend shows it read-only, with a link to the file.
- A person changes a git-managed item through an agent using its own git tools. HelpOS needs read access to the repo only.
- Moving a kind back to `app` keeps the current rows and clears `source_*`. An export endpoint writes app-managed items in the same file layout.

One owner prevents conflicting edits between the API and the repo. Agents can propose file changes with their existing tools.

### 4. Atomic, idempotent import

- A signed push webhook or a manual sync request enqueues a tenant job with `{tenantId, integrationId, commitSha}`, IDs only ([ADR 0009](0009-tenant-isolation-extended.md)).
- The job fetches that exact commit, validates every file, and applies the whole set in one `withTenant()` transaction. It creates and updates items and deletes items whose files are gone. If any file fails, nothing applies, the last good commit stays live, and the error names its file, line and reason.
- Import is idempotent on `commitSha`. An older commit than the one applied is ignored, so out-of-order webhooks cannot undo newer content.
- Every import is audited with the commit SHA and author. Each changed row's audit event points to that import.
- Knowledge files use the normal ingestion path for chunking, embedding and storing passages.

### 5. Rules and settings cannot widen authority without approval

Repo access is not workspace admin access. An import that widens a permission, raises a cap or removes an approval step is staged until an admin approves it through the signed-approval path. Tightening changes apply at once. This is the git case of [ADR 0011](0011-the-gate.md) section 7.

### 6. Files follow the API trust boundary

Knowledge and saved replies are data, quoted to the model and never merged into its instructions. Rules and settings are trusted exactly as much as the same change through the API, no more. Frontmatter cannot set a field the API does not let a person set ([ADR 0004](0004-security-baseline.md)).

### 7. Tenant isolation and secrets

- A repo connection belongs to a tenant. Its read-only credential is envelope-encrypted.
- One repo, optionally with a subfolder, belongs to one workspace. Every imported row has `tenant_id` under RLS.
- Files never hold secrets. A rule or setting refers to an integration by name. The importer rejects files that match secret-scanning patterns, so a key pushed by mistake never reaches the database.
- Repo fetches use SSRF-safe fetch. Self-hosters can use any git host over HTTPS.

### 8. Data model before sync

Every table holding one of the four kinds has `managed_by text not null default 'app'`, `source_path text null` and `source_commit text null`. Each item has a stable slug, unique per workspace, that can map to a file path. Knowledge source kinds must allow a git source without changing this ownership metadata.

The columns make git ownership explicit before sync is built. `knowledge_sources` already has the ownership columns.

## Consequences

- Teams that never connect a repo use app-managed items and see no difference.
- A person without git skills changes a git-managed item through an agent, or keeps that kind managed in the desk.
- Loosening a rule or setting needs a reviewed repo change and an admin's approval in the desk, because push access cannot grant workspace authority.
- The sync ships with tests for atomic import, ignored older commits, refused API writes to git-managed items, approval of authority-widening imports, rejected secrets, and tenant isolation. An eval checks that instructions hidden in a knowledge file are not followed.
