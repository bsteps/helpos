# 0001. Record architecture decisions

- Status: Accepted
- Date: 2026-11-06

## Context

HelpOS is built by a small team working with AI coding agents. Agents and new contributors keep no memory of earlier discussions, so without a record they re-open settled questions or quietly contradict them.

## Decision

We record every significant decision as a short ADR in `docs/adr/`. `AGENTS.md` tells coding agents to read the relevant ADRs before changing architecture.

## Consequences

- The reasons behind a decision outlive the chat thread they came from.
- When an approved decision changes, update its ADR and references directly. Keep only the current decision and its reason, so contributors and agents have one answer to follow. Git keeps the history.
- Write a new ADR for a new decision. Remove a redundant ADR and update its references rather than keep conflicting versions.
