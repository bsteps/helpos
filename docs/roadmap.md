# Roadmap

How we get from here to the [vision](vision.md). Each milestone is one part of the product, and it ends with a checkpoint. When this page disagrees with the vision, the vision wins. Accepted ADRs still bind: changing one means updating that ADR.

## How a milestone works

A milestone is one capability you can see and try, not a list of tasks. It ends with a checkpoint issue (labelled `human-only`), and the next milestone starts only once that issue is closed. At the checkpoint we:

1. **Understand** what was built and how it fits with the rest.
2. **Test** it by hand, in the running app and through the API, failure cases included.
3. **Change** what you don't like, file it in the same milestone and fix it.
4. **Decide** open questions, and update the ADRs and docs.
5. **Re-plan** the next milestones from what we learned.

Only the next two or three milestones get detailed plans. Later ones are a direction, and they change at checkpoints.

## Principles

- **Pipes, not features.** If an agent can do it in one prompt, it isn't on this list.
- **Understand before building on.** Milestones 1 to 6 are checkpoints over what already exists, so new work builds on parts that are understood and tested.
- **Clean foundation first.** New work builds only on code that is clean and proven by tests, so the foundation milestone comes before milestone 7.
- **The gate first.** Milestones 7 to 9 build the gate, and every later pipe goes through it.
- **Prove the loop before widening the tool surface.** Outside tools connect only once fewer decisions without worse answers is shown (#185).
- **Remove what the vision replaced, only once the replacement works.**

## What works today

Email comes in and becomes a conversation. The AI drafts a reply from the workspace's knowledge, with citations. A person approves it, and it is sent in shadow mode, so every reply goes to the workspace owner, never to a real customer. Agents do the same through the public API with scoped tokens, and every action is audit-logged.

## Part 1: what we already have

These milestones build nothing new. Each one is a checkpoint over a part that already works, plus the small fixes it turns up.

| Milestone                                                                      | You'll understand and test                                                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| [1. Email in, conversation out](https://github.com/bsteps/helpos/milestone/16) | How a forwarded email becomes a conversation: threading, customers, attachments (#131), and what happens to bad mail |
| [2. Knowledge](https://github.com/bsteps/helpos/milestone/17)                  | Adding sources, how pages are fetched and split, public vs internal content, and how the AI finds answers            |
| [3. AI drafts](https://github.com/bsteps/helpos/milestone/18)                  | How a draft is written, its citations, cost limits, what happens when the AI fails, and how helpful drafts are       |
| [4. Approve, edit and send](https://github.com/bsteps/helpos/milestone/19)     | The decision on each draft, shadow mode, failed and uncertain sends, and the formal model behind sending             |
| [5. Agent access](https://github.com/bsteps/helpos/milestone/20)               | Tokens, scopes, the audit log, and safe retries (#346)                                                               |
| [6. The dashboard and alerts](https://github.com/bsteps/helpos/milestone/21)   | What a person sees and does, and the email alerts                                                                    |

## Foundation

[0: Clean foundation](https://github.com/bsteps/helpos/milestone/15) runs alongside Part 1. It fixes the audit's architecture debt, proves every behaviour with a test, and turns every judgment-only rule that can be a check into one. Repo tooling issues go here too. It has to be done before milestone 7 starts.

## Part 2: toward the vision

| Milestone                                                                        | You'll see and test                                                                                                                                                        |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [7. Every agent has an identity](https://github.com/bsteps/helpos/milestone/22)  | Each agent, the built-in one included, has its own permissions and an off switch, and no agent can approve. You try to approve as an agent and turn one off                |
| [8. One place for decisions](https://github.com/bsteps/helpos/milestone/23)      | Everything an agent wants to do lands as a decision. You approve, edit or reject on one page, get alerts in Slack and email, and what you approved is exactly what happens |
| [9. One owner per conversation](https://github.com/bsteps/helpos/milestone/24)   | Two agents work at once. Only one owns a conversation, stale proposals are rejected, and nothing is ever resent automatically                                              |
| [10. Rules the desk remembers](https://github.com/bsteps/helpos/milestone/25)    | When the agent is unsure it asks you once. Your answer becomes a rule that is rechecked when things change. A rule can never widen an agent's authority on its own         |
| [11. Undo](https://github.com/bsteps/helpos/milestone/26)                        | You revert any internal change from its history. Irreversible actions stay behind your approval                                                                            |
| [12. Customers always know](https://github.com/bsteps/helpos/milestone/27)       | Every reply shows it is AI, and a customer can always reach a person                                                                                                       |
| [13. Answers with sources](https://github.com/bsteps/helpos/milestone/28)        | The agent answers only from a source. Missing sources become knowledge gaps ranked by demand. AI output is cleaned, and personal data is masked before the AI sees it      |
| [14. Bring your old helpdesk](https://github.com/bsteps/helpos/milestone/29)     | You import an export (Crisp first) and see how the agent would have answered your last 200 conversations, in shadow mode. Backups and data retention are in place first    |
| [15. The one number](https://github.com/bsteps/helpos/milestone/30)              | You see how much human work it takes per 100 conversations, and whether customers stay happy                                                                               |
| [16. Real email](https://github.com/bsteps/helpos/milestone/31)                  | Sender checks, your own sending domain, bounces, clean quoted replies, signed inbound mail, rate limits and encrypted secrets. You send real replies to real customers     |
| [17. Trust from outcomes](https://github.com/bsteps/helpos/milestone/32)         | Real outcomes move each agent's actions up or down the trust ladder, and you accept every promotion                                                                        |
| [18. Your own agent connects](https://github.com/bsteps/helpos/milestone/33)     | Your Claude Code or Codex works the desk through MCP and skills, with tokens that expire, an audit log it can read, and other tools connected through the gate             |
| [19. The desk wakes agents](https://github.com/bsteps/helpos/milestone/34)       | Webhooks, an event feed and schedules start agents when something happens                                                                                                  |
| [20. Shared work](https://github.com/bsteps/helpos/milestone/35)                 | Queues, handoffs between agents, and waiting lists: everyone waiting on one fix hears when it is done                                                                      |
| [21. Knowledge stays fresh](https://github.com/bsteps/helpos/milestone/36)       | Releases and changes flag stale knowledge, and sources get rechecked                                                                                                       |
| [22. Customers and search](https://github.com/bsteps/helpos/milestone/37)        | Agents and people find any customer or conversation, and work with tags and saved replies                                                                                  |
| [23. Your agent sets up the desk](https://github.com/bsteps/helpos/milestone/38) | A new workspace is configured end to end by an agent, with the human-only settings refused                                                                                 |
| [24. Hosted](https://github.com/bsteps/helpos/milestone/39)                      | A stranger signs up and gets value in 10 minutes, on one price slider that includes AI, with privacy and abuse protection                                                  |

Shadow mode stays on until milestone 16: every item in the [release-safety list](architecture/overview.md#shortcuts-before-the-first-real-reply) lands before the first real reply. Billing (with Dodo Payments), metering and hosted admin live in the private hosted-service repo (ADR 0007). Everything else stays here.

## Later (on demand)

The [Later milestone](https://github.com/bsteps/helpos/milestone/7) holds what waits for demand:

- More frontends: the chat widget (#399), headless help-center pages (#405), and teams' own dashboards on our API and MCP (#400)
- **Rules, knowledge and settings in git** (ADR 0010, accepted). The sync waits, but new tables must keep it possible
- #20 observability · #23 release automation · #205 evals against a real model
- #57 routing by envelope recipient · #90 #91 #92 knowledge re-ingest and vector recall
- More channels: Slack, Discord, WhatsApp, SMS, voice
- Enterprise: SSO, SCIM, data residency, SOC 2
- OAuth login (GitHub, Google)
- #25 CLA lawyer review · #30 OpenSSF Scorecard

## Not on the roadmap

These are the agent's job, not ours: reports and dashboards, CSAT analysis, automation rules and routing logic, saved-reply and tag _choices_, article writing, crawling whole websites, per-platform importers, tracker tickets, changelogs, and coding fixes. HelpOS stores and serves the data. Agents decide what goes in it.
