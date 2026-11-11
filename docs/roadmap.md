# Roadmap

How we get from here to the [vision](vision.md). Each set is a GitHub milestone with one exit goal. Nothing lands before what it depends on. When this page disagrees with the vision, the vision wins. Accepted ADRs still bind: changing one takes a new ADR.

## Principles

- **Pipes, not features.** If an agent can do it in one prompt, it isn't on this list.
- **The gate first.** Every later pipe goes through it.
- **Shadow mode early.** Shadow mode sends nothing to customers, so set B can be built alongside the gate.
- **Prove the loop before widening the tool surface.** Fewer decisions without worse answers comes before connecting more outside tools.
- **Remove what the vision replaced, only once the replacement works.**

## The sets

| Set                              | Exit goal                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ **MVP**                       | Email → ticket → AI draft → approve → send, in shadow mode                                                                                                    |
| **A. The gate**                  | Every action from any agent goes through one gate, and tests prove one writer and nothing sent twice                                                          |
| **B. Shadow mode** (alongside A) | Conversations imported from another helpdesk are replayed in shadow mode, a person reviews how the agent would have answered, and decision demand is measured |
| **C. Bring your agent**          | An outside agent (Claude Code, Codex) runs the improve loop on a workspace through MCP                                                                        |
| **D. Safe real mail**            | Shadow mode can be turned off: replies reach real customers safely, and customer outcomes are measured                                                        |
| **E. Paid hosted**               | Hosted sign-up, billing and onboarding work end to end                                                                                                        |
| **Later**                        | On demand                                                                                                                                                     |

## A. The gate

- #130 nothing sent twice · #139 send-failed replies under load
- #165 one owner per conversation: expiring claims and versions
- #13 the gate: per-agent permissions, caps, kill switch
- #166 trust ladder per agent and action type
- #167 playbook: ask once, remember, recheck
- #168 AI disclosure and an always-available human handoff
- #85 audit records the reason and the inputs · #10 API conventions (idempotency)

## B. Shadow mode

- #169 bulk import · #170 Crisp migration skill · #179 replay imported conversations and review the answers
- #178 no source, no answer
- #171 approval page with Slack and email alerts · #124 tell the owners when a reply can't be sent · #131 inbound attachments
- #172 knowledge gaps ranked by demand
- #77 product events and the one number

## C. Bring your agent

In this order: the improve loop first, outside tools last.

- #19 MCP server and skills, with features that announce themselves
- #17 wake-ups: signed webhooks, event feed, fallback
- #176 freshness loop: change events, last-checked dates, staleness flags
- #173 queues and handoff
- #71 waiting lists, then #175 remove the GitHub-specific code
- #12 token rotation · #14 audit log query API
- #15 envelope encryption, then #174 any MCP tool through the gate

## D. Safe real mail

- **Email:** #31 SPF/DKIM/DMARC · #74 sending domain and DKIM signing · #75 bounces and quote stripping · #57 routing by envelope recipient
- **Security:** #52 sanitising and PII masking · #29 rate limiting · #8 leak harness · #28 threat model · #78 incident response and retention
- **Team:** #11 invites, password reset, roles
- **Ops:** #18 #6 separate worker · #20 observability · #21 production Docker + Compose · #76 backup, restore, doctor · #23 release automation · #22 quality gates and performance budgets

## E. Paid hosted

- Hosted sign-up: forward your support email, DNS check, shadow mode on by default
- One slider by conversations, every feature on every plan. AI with your own key or ours at cost
- Billing with Dodo Payments
- Privacy policy, DPA, subprocessor list · GDPR export and delete
- Trial abuse and spam sign-up protection

Billing, metering and hosted admin live in the private hosted-service repo (ADR 0007). Everything else stays here.

## Later (on demand)

- **The dashboard step:** settings and stats you can read without paying for AI, with the layout shaped by the agent
- **Config, knowledge and policies in git** (ADR 0010, accepted). The sync waits, but new tables must keep it possible
- #90 #91 #92 knowledge re-ingest and vector recall
- More channels: chat widget, Slack, Discord, WhatsApp, SMS, voice
- Enterprise: SSO, SCIM, data residency, SOC 2
- #25 CLA lawyer review · #30 OpenSSF Scorecard

## Not on the roadmap

These are the agent's job, not ours: reports and dashboards, CSAT analysis, automation rules and routing logic, saved-reply and tag _choices_, article writing, website import, per-platform importers, tracker tickets, changelogs, and coding fixes. HelpOS stores and serves the data. Agents decide what goes in it.
