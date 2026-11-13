# HelpOS

**A helpdesk that runs and improves itself. You approve.**

> 🚧 **Pre-alpha.** We're building the foundation in public. Nothing is usable yet. Star or watch the repo to follow along.

## Why HelpOS?

Today's helpdesks are huge systems built for a human to set up, read and operate, and nobody really does. The knowledge base goes stale and the AI makes things up. Bugs get relayed to developers over chat and forgotten. "It's fixed" is sent by hand, or never.

HelpOS is the **desk**, not the worker. AI agents (ours, or your own Claude Code, Codex or custom agent) do the support work at the desk. You decide, correct and teach. The desk makes that safe, fast and visible.

The whole vision fits on one page: [docs/vision.md](docs/vision.md).

## How it works

- **One gate.** Every action an agent wants goes through the same gate, whether the agent is ours or yours. Actions it has earned trust for happen right away. The rest wait in your queue.
- **Trust is earned from outcomes.** Per agent and per action type. Approvals without edits and happy customers move an action up. Corrections and unhappy returns move it down. Anything that can't be undone, like outbound email, starts at "you approve".
- **Two loops.** Agents handle conversations around the clock. And an agent improves the desk itself: it keeps the knowledge fresh, finds bottlenecks and proposes fixes, each one landing in your queue.
- **Inbox zero means zero decisions.** Your home screen is the decisions waiting for you, not a list of conversations.
- **No source, no answer.** Factual claims need a source. A missing source becomes a knowledge gap, never a guess.
- **Customers always know it's AI**, and can always reach a person.

## What makes it different

- **Bring any agent.** Your own agents plug in through the API and MCP, and HelpOS ships skills that teach them to run it.
- **Pipes, not features.** If an agent can do it in one prompt, we don't build it. We build what agents can't safely do alone.
- **Simple pricing on the hosted version.** One slider by conversations, every feature on every plan. AI is included up to a fair allowance per conversation, and you can bring your own key any time for the same price.
- **Self-host anywhere, free.** One Docker image + Postgres, on any VPS, cloud or your laptop.
- **Secure by design.** Database-level tenant isolation, scoped agent permissions, approvals and a full audit log.

## Status

Working today: email → conversation → AI draft → approve → send, in shadow mode.

| Set                     | Goal                                                                                                   |         |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | ------- |
| **0. Clean foundation** | Clean the existing code and prove every behaviour with a test before new work builds on it             | 🚧 Now  |
| **A. The gate**         | Every action from any agent goes through one gate; one writer at a time, no automatic resend           | ⏭️ Next |
| **B. Shadow mode**      | Import conversations from another helpdesk and review how the agent would have answered                | ⏳      |
| **C. First real reply** | Real replies to real customers, with every release-safety item in place and customer outcomes measured | ⏳      |
| **D. Bring your agent** | The improve loop runs, from the built-in agent and from your own agent through MCP                     | ⏳      |
| **E. Paid hosted**      | Hosted sign-up, onboarding and one-slider pricing                                                      | ⏳      |

Every set and exit goal is in [docs/roadmap.md](docs/roadmap.md).

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
