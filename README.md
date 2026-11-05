# HelpOS

**The open-source, agent-first helpdesk.**

> 🚧 **Pre-alpha.** We're building the foundation in public. Nothing is usable yet. Star or watch the repo to follow along.

## Why HelpOS?

<!--
  TODO (first PR): write the vision here in your own words, 3-6 short lines.
  Who is it for, what's broken about today's helpdesks, and what HelpOS does differently.
-->

## What makes it different

- **Agent-first.** AI agents handle support, and humans approve, handle exceptions and teach.
- **Bring your own agent or AI key, for free.** Every feature is available through the public API, MCP server and webhooks.
- **Simple pricing on the hosted version.** One price by conversations, unlimited team members, AI included. No per-seat fees and no AI tolls.
- **Self-host anywhere, free.** One Docker image + Postgres, on any VPS, cloud or your laptop.
- **Secure by design.** Database-level tenant isolation, scoped agent permissions, approvals and a full audit log.

## Status

| Phase | What                                                                             | Status         |
| ----- | -------------------------------------------------------------------------------- | -------------- |
| 0     | Foundation: tooling, CI, database + tenant isolation, auth, API, security layers | 🏗️ In progress |
| 1     | Core: conversations, inbox, realtime                                             | ⏳             |
| 2     | Channels + AI: chat widget, email, help center, AI answers                       | ⏳             |
| 3     | Agent-native: public support MCP, bug → PR loop                                  | ⏳             |

## Contributing

We'd love your help. Start with [CONTRIBUTING.md](CONTRIBUTING.md). New to open source? Read [docs/OPEN_SOURCE_101.md](docs/OPEN_SOURCE_101.md).

Using an AI coding agent? It should read [AGENTS.md](AGENTS.md) first.

## Our open-source promise

HelpOS is licensed under **AGPL-3.0**. The core helpdesk features will **stay open source**. We won't move existing features behind a paywall. Our hosted service pays for development by running HelpOS for you, not by locking features away.

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0](LICENSE). Contributions require signing our [CLA](CLA.md); a bot asks on your first pull request. The HelpOS name and logo are covered by our [trademark policy](TRADEMARK.md).
