# 0008. Collect CLA signatures with cla-assistant.io

- Status: Accepted
- Date: 2026-11-06

## Context

CLA collection must block unsigned contributions without running fork-controlled workflow code with repository write permissions.

## Decision

- Use the hosted **cla-assistant.io** GitHub App. It is still maintained, though with low activity; signatures can be exported, so we can switch tools if needed. The CLA text lives in `CLA.md` and in a gist that the app reads.
- Its status check (`license/cla`) is a **required** check on `main`, so an unsigned contribution can't be merged.

## Consequences

- No CLA workflow code to maintain in this repo, and no write-permission workflow triggered by forks.
- Signatures are stored by cla-assistant.io and can be exported.
