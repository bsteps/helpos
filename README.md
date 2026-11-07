# HelpOS

**The open-source, agent-first helpdesk.**

> 🚧 **Pre-alpha.** We're building the foundation in public. Nothing is usable yet. Star or watch the repo to follow along.

## Why HelpOS?

Small support teams drown in repetitive tickets, and most helpdesks still treat AI as a bolt-on chatbot.
HelpOS flips that: AI agents do the routine support work, and humans approve risky actions, handle the exceptions and teach the agents.
Agents are first-class users, so anything you can do in the UI, an agent can do through the public API, and every action is scoped and audit-logged.
It's open source (AGPL-3.0) and self-hostable, so you own your data and your support stack.

## What makes it different

- **Agent-first.** AI agents handle support, and humans approve, handle exceptions and teach.
- **Bring your own agent or AI key, for free.** Every feature is available through the public API, MCP server and webhooks.
- **Simple pricing on the hosted version.** One price by conversations, unlimited team members, AI included. No per-seat fees and no AI tolls.
- **Self-host anywhere, free.** One Docker image + Postgres, on any VPS, cloud or your laptop.
- **Secure by design.** Database-level tenant isolation, scoped agent permissions, approvals and a full audit log.

## Status

| Set | What                                                                         | Status         |
| --- | ---------------------------------------------------------------------------- | -------------- |
| MVP | Email → AI draft → approve → send → GitHub issue → "fixed", in shadow mode   | 🏗️ In progress |
| 2a  | Real customer mail, coding agent opens the fix PR, release security controls | ⏳             |
| 2b  | Paid hosted: sign-up, billing, privacy                                       | ⏳             |
| 3   | Complete helpdesk: inbox tools, widget, help center, autopilot               | ⏳             |
| 4   | Platform + growth: SDK, config in git, AI actions, automation, reports       | ⏳             |

Every feature and exit goal is in [docs/roadmap.md](docs/roadmap.md).

## Contributing

We'd love your help. Start with [CONTRIBUTING.md](CONTRIBUTING.md). New to open source? Read [docs/OPEN_SOURCE_101.md](docs/OPEN_SOURCE_101.md). To see how the system fits together, read [docs/architecture/overview.md](docs/architecture/overview.md).

Using an AI coding agent? It should read [AGENTS.md](AGENTS.md) first.

## Our open-source promise

HelpOS is licensed under **AGPL-3.0**. The core helpdesk features will **stay open source**. We won't move existing features behind a paywall. Our hosted service pays for development by running HelpOS for you, not by locking features away.

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

Copyright © 2026 Nishant Tadvi and HelpOS contributors. Licensed under [AGPL-3.0](LICENSE). Contributions require signing our [CLA](CLA.md); a bot asks on your first pull request. The HelpOS name and logo are covered by our [trademark policy](TRADEMARK.md).
