# Roadmap

How we get from here to the [vision](vision.md). Each set is a GitHub milestone with one exit goal. Nothing lands before what it depends on. When this page disagrees with the vision, the vision wins. Accepted ADRs still bind: changing one takes a new ADR.

## Principles

- **Pipes, not features.** If an agent can do it in one prompt, it isn't on this list.
- **Clean foundation first.** New work builds only on code that is clean and proven by tests, so set 0 comes before the gate.
- **The gate first.** Every later pipe goes through it.
- **Real replies early.** Trust is earned from outcomes, and outcomes exist only once real replies reach customers. So the first real reply comes right after the gate and shadow mode, before the improve loop.
- **Prove the loop before widening the tool surface.** Outside tools connect only once fewer decisions without worse answers is shown (#185).
- **Remove what the vision replaced, only once the replacement works.**

## What works today

Email comes in and becomes a conversation. The AI drafts a reply from the workspace's knowledge, with citations. A person approves it, and it is sent in shadow mode, so every reply goes to the workspace owner, never to a real customer. Agents do the same through the public API with scoped tokens, and every action is audit-logged.

## The sets

| Set                             | Exit goal                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. Clean foundation**         | The audit's architecture debt is fixed, every behaviour is proven by a test, and every judgment-only rule that can be a check is one                          |
| **A. The gate**                 | Every action from any agent goes through one gate, and tests prove one writer at a time, no automatic resend, and agents can't approve                        |
| **B. Shadow mode** (after #187) | Conversations imported from another helpdesk are replayed in shadow mode, a person reviews how the agent would have answered, and decision demand is measured |
| **C. First real reply**         | One workspace sends real replies to real customers with every release-safety item in place, and customer outcomes are measured                                |
| **D. Bring your agent**         | The improve loop runs, from the built-in agent on a schedule and from an outside agent (Claude Code, Codex) through MCP. Outside tools connect last           |
| **E. Paid hosted**              | Hosted sign-up, onboarding, one-slider pricing and privacy work end to end                                                                                    |
| **Later**                       | On demand                                                                                                                                                     |

## 0. Clean foundation

The existing code is cleaned before new work builds on it. The [0: Clean foundation milestone](https://github.com/bsteps/helpos/milestone/15) is the full list, including every issue the code audit files there. It started with:

- #8 leak harness, before the new tables of A and B
- #184 rename tickets to conversations, before MCP tools are generated (#19)
- #130 no automatic resend · #139 send-failed replies under load
- #85 audit records the reason and the inputs · #10 API conventions (idempotency)
- #22 quality gates and performance budgets

## A. The gate

- #28 threat model, first pass, before the gate is designed
- #187 the one decision record. Set B starts once it lands
- #165 one owner per conversation: expiring claims and versions
- #13 the gate: an identity per agent (the built-in one too), permissions, and human-only approval
- #188 caps and kill switch (only a person turns it off) · #189 approved means exactly that action
- #166 trust ladder: state, demotion and caps now. Promotions open once real outcomes exist (after C)
- #167 playbook: ask once, remember, recheck. It can never widen authority on its own
- #168 AI disclosure, and "talk to a human" creates a decision for a person

## B. Shadow mode

- #169 bulk import · #170 Crisp migration skill (a versioned file the built-in agent runs on an export)
- #179 replay without peeking at the real reply, then re-run after knowledge gaps close: the improve loop's first proof
- #178 no source, no answer
- Before real conversations are imported and sent to a model: #52 sanitising and PII masking · #29 rate limiting · #76 backup and restore · #78 retention and incident response
- #171 approval page with Slack and email alerts · #124 tell the owners when a reply can't be sent · #131 inbound attachments
- #172 knowledge gaps ranked by demand
- #77 product events and decision demand

## C. First real reply

The remaining release-safety items from the [architecture overview](architecture/overview.md#shortcuts-before-the-first-real-reply), plus real email basics.

- **Safety:** #31 SPF/DKIM/DMARC · #15 envelope encryption
- **Email:** #74 sending domain and DKIM signing · #75 bounces and quote stripping
- **Runs on** the existing image and demo compose. The production self-hosting release is #21 in E
- **Outcomes:** #185 live outcomes, observation window, sampled quality checks · #186 trust promotions from real outcomes

## D. Bring your agent

- #19 MCP server and skills, with features that announce themselves
- #17 wake-ups: signed webhooks, event feed, fallback
- #176 freshness loop: knowledge revisions, change events, staleness flags
- #173 queues and handoff
- #71 waiting lists, then #175 remove the GitHub-specific code
- #12 token rotation · #14 audit log query API
- Last, once #185 shows fewer decisions without worse answers: #174 any MCP tool through the gate

## E. Paid hosted

- #180 sign-up to first replayed answer in minutes
- #181 one slider by conversations with an AI allowance. Bring your own key always allowed
- #182 export and deletion · #183 sign-up abuse protection
- #11 invites, password reset, roles · #21 production Docker + Compose · #18 #6 separate worker

Billing (with Dodo Payments), metering and hosted admin live in the private hosted-service repo (ADR 0007). Everything else stays here.

## Later (on demand)

- **The dashboard step:** settings and stats you can read without paying for AI, with the layout shaped by the agent
- **Rules, knowledge and settings in git** (ADR 0010, accepted). The sync waits, but new tables must keep it possible
- #20 observability · #23 release automation
- #57 routing by envelope recipient · #90 #91 #92 knowledge re-ingest and vector recall
- More channels: chat widget, Slack, Discord, WhatsApp, SMS, voice
- Enterprise: SSO, SCIM, data residency, SOC 2
- OAuth login (GitHub, Google)
- #25 CLA lawyer review · #30 OpenSSF Scorecard

Repo tooling issues (#113, #115, #126, #127) have no milestone. Pick them up any time.

## Not on the roadmap

These are the agent's job, not ours: reports and dashboards, CSAT analysis, automation rules and routing logic, saved-reply and tag _choices_, article writing, crawling whole websites, per-platform importers, tracker tickets, changelogs, and coding fixes. HelpOS stores and serves the data. Agents decide what goes in it.
