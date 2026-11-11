# HelpOS

**A helpdesk that runs and improves itself. You approve.**

> 🚧 **Pre-alpha.** We're building the foundation in public. Nothing is usable yet. Star or watch the repo to follow along.

## Why HelpOS?

Today's helpdesks are huge systems built for a human to set up, read and operate, and nobody really does.
HelpOS is the **desk** where AI agents (ours, or your own Claude Code, Codex or custom agent) do the support work and keep improving the desk itself. You decide, correct and teach.
Agents propose, and the desk decides: every action passes one gate, is audited, and goes out only once that agent has earned trust for it.

The whole vision fits on one page: [docs/vision.md](docs/vision.md).

## What makes it different

- **Agents propose, the desk decides.** Trust is earned per agent and per action type. Your home screen is the decisions waiting for you, not a ticket list.
- **Bring any agent.** Your own agents plug in through the API and MCP, and HelpOS ships skills that teach them to run it.
- **Pipes, not features.** We build what agents can't safely do alone, and leave the rest to the agent.
- **Simple pricing on the hosted version.** One slider by conversations, every feature on every plan. AI is included up to a fair allowance per conversation, and you can bring your own key any time. AI isn't where we make money.
- **Self-host anywhere, free.** One Docker image + Postgres, on any VPS, cloud or your laptop.
- **Secure by design.** Database-level tenant isolation, scoped agent permissions, approvals and a full audit log.

## Status

| Set                     | What                                                                                                            | Status  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | ------- |
| MVP                     | Email → AI draft → approve → send, in shadow mode                                                               | ✅      |
| **0. Clean foundation** | Clean the existing code and prove every behaviour with tests before new work builds on it                       | 🚧 Now  |
| **A. The gate**         | One owner per conversation, no automatic resend, per-agent permissions, agents can't approve, trust ladder      | ⏭️ Next |
| **B. Shadow mode**      | Bulk import, replay and review, no source no answer, PII masking, approval page, knowledge gaps, the one number | ⏭️ Next |
| **C. First real reply** | Release-safety items, real email basics, customer outcomes                                                      | ⏳      |
| **D. Bring your agent** | MCP + skills, wake-ups, freshness loop, queues, waiting lists, then outside tools                               | ⏳      |
| **E. Paid hosted**      | Sign-up, one slider with an AI allowance, privacy                                                               | ⏳      |

Every feature and exit goal is in [docs/roadmap.md](docs/roadmap.md).

## Contributing

Running it yourself? See [docs/self-hosting.md](docs/self-hosting.md) for Postgres (pgvector) and AI settings.

We'd love your help. Start with [CONTRIBUTING.md](CONTRIBUTING.md). New to open source? Read [docs/OPEN_SOURCE_101.md](docs/OPEN_SOURCE_101.md). To see how the system fits together, read [docs/architecture/overview.md](docs/architecture/overview.md).

Using an AI coding agent? It should read [AGENTS.md](AGENTS.md) first.

## Our open-source promise

HelpOS is licensed under **AGPL-3.0**. The core helpdesk features will **stay open source**. We won't move existing features behind a paywall. Our hosted service pays for development by running HelpOS for you, not by locking features away.

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

Copyright © 2026 Nishant Tadvi and HelpOS contributors. Licensed under [AGPL-3.0](LICENSE). Contributions require signing our [CLA](CLA.md); a bot asks on your first pull request. The HelpOS name and logo are covered by our [trademark policy](TRADEMARK.md).
