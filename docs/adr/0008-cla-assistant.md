# 0008. Collect CLA signatures with cla-assistant.io

- Status: Accepted
- Date: 2026-11-06
- Supersedes: the "collected by a GitHub Action" part of ADR 0007

## Context

ADR 0007 used `contributor-assistant/github-action` (CLA Assistant Lite). That repository was archived in March 2026 and no longer gets security fixes, yet it ran on `pull_request_target` with write permissions.

## Decision

- Use the hosted **cla-assistant.io** GitHub App (actively maintained). The CLA text lives in `CLA.md` and in a gist that the app reads.
- Its status check (`license/cla`) is a **required** check on `main`, so an unsigned contribution can't be merged.
- Remove the archived workflow and the `cla-signatures` branch.

## Consequences

- No CLA workflow code to maintain in this repo, and no write-permission workflow triggered by forks.
- Signatures are stored by cla-assistant.io and can be exported.
