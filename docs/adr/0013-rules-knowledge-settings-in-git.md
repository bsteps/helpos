# 0013. Rules, knowledge and settings in git

- Status: Accepted
- Date: 2026-11-13
- Supersedes: in ADR 0010, the kinds (section 1), the pull request opened from the UI (sections 3 and 7, and the consequences), the policy wording (sections 5, 6 and 7), and the timing (the context, section 8 and the consequences)

## Context

ADR 0010 lets a workspace keep some of its config in git, with the database as the runtime source of truth and a one-way import. That design holds. Some of its details were written for an earlier plan:

- Two of its kinds are AI instructions and agent policies. The [vision](../vision.md) has rules (the playbook), knowledge and settings, and ADR 0011 replaces policy thresholds with the gate.
- It promises that editing a git-managed item in the UI opens a pull request. That needs an edit screen for every kind. Agents use the API, and until the dashboard step the screens are for decisions and conversations.
- It ties the timing to an older roadmap set.

ADR 0010 sections 2 and 4 hold as written. Sections 3, 5, 6 and 7 hold with the changes below.

## Decision

### 1. Four kinds can live in git

| Kind          | Folder       | Example                     | Treated as                                    |
| ------------- | ------------ | --------------------------- | --------------------------------------------- |
| Knowledge     | `knowledge/` | `knowledge/refunds.md`      | **Data**, quoted to the AI                    |
| Saved replies | `replies/`   | `replies/password-reset.md` | **Data**, as in ADR 0010                      |
| Rules         | `rules/`     | `rules/tone.md`             | Workspace config, the playbook agents follow  |
| Settings      | `settings/`  | `settings/channels.md`      | Workspace config, values the API lets you set |

Rules replace `instructions/` and `policies/`. Settings hold the values a person sets through the API, such as channel settings.

Each file is markdown with YAML frontmatter (`id`, `kind`, `version` and fields for its kind), validated by a Zod schema per kind. The body is the content.

**Never in git:** conversations, messages, customers, the audit log, memberships, tokens, secrets, trust levels and kill switches. Trust is earned from outcomes and accepted by a person in the desk (ADR 0011), so a file can't set it. A file can't turn a kill switch off.

Reason: rules and settings are the words the vision and the gate use, so a team's repo has the same shape as its desk.

### 2. A git-managed item changes only in its file

The API rejects a write to a git-managed item with `409` and a hint to change the file instead. Anything that shows the item shows it read-only, with a link to the file.

HelpOS doesn't turn edits into pull requests. A person who wants to change a git-managed item asks an agent. The agent changes the file and opens the pull request with its own git tools.

A repo connection needs read access only.

Reason: opening a pull request is one prompt away for an agent with git access. Building it would need an edit screen for every kind, and write access to every connected repo.

### 3. Rules and settings from git can't widen authority

ADR 0010 section 5 applies to rules and settings. An import that loosens anything (widens a permission, raises a cap, or removes an approval step) waits until an admin approves it in the desk. A change that tightens applies at once. This is the git case of ADR 0011 section 7.

### 4. Rules and settings files are trusted as much as the API

ADR 0010 section 6 applies with rules and settings in place of `instructions/`. A rules or settings file is trusted exactly as much as the same change made through the API, no more. Knowledge and saved replies stay data. Frontmatter can't set a field the API doesn't let a person set. A rule or setting that needs a secret refers to an integration by name.

### 5. Before the sync is built

The sync waits, but new tables must keep it possible. Every table that holds one of the four kinds has `managed_by text not null default 'app'`, `source_path text null` and `source_commit text null`. Each item has a stable slug, unique per workspace, that can map to a file path. `knowledge_sources` already has these columns.

The tests named in ADR 0010's consequences ship with the sync, with "policy" read as "a rule or setting".

## Rejected

- **Keep `instructions/` and `policies/`.** They match neither the playbook nor the gate, so a team would map between two sets of names.
- **A pull request opened from the UI.** It needs edit screens and write access, and an agent already does it.
- **Trust levels in git.** Push access would then grant trust that only outcomes and a person's yes should grant.

## Consequences

- Teams that never connect a repo see no difference.
- A person without git skills changes a git-managed item through an agent, or keeps that kind managed in the desk.
- Loosening a rule or setting from git needs a pull request and an admin's approval in the desk. That is slower on purpose, because repo access is not admin access.
