# 0001. Record architecture decisions

- Status: Accepted
- Date: 2026-11-06

## Context

HelpOS is built by a small team working with AI coding agents. Agents and new contributors keep no memory of earlier discussions, so without a record they re-open settled questions or quietly contradict them.

## Decision

We record every significant decision as a short ADR in `docs/adr/`. `AGENTS.md` tells coding agents to read the relevant ADRs before changing architecture.

## Consequences

- The reasons behind a decision outlive the chat thread they came from.
- Changing a decision means writing a new ADR that supersedes the old one, never silently editing the old one.
