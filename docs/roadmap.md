# Roadmap

Every feature we want over the product's lifetime, grouped into sets. Each set is a finished, usable product for a named user, with one exit goal. Nothing lands before what it depends on. Sets are sized for one or two people working with coding agents.

Each set is a GitHub milestone. MVP and Set 2a have issues. Later sets are rows here until we start them, so the tracker doesn't fill with stale issues. `#n` is an existing issue; ✅ means it's built.

## Principles

- **Wedge first.** "Support that fixes its own bugs" ships before generic helpdesk breadth.
- **Riskiest assumption first.** Before automating the coding-agent step, we test it by hand (#69).
- **Hosted first, paid early.** Design partners pay as soon as they're on real mail, by invoice first. We build billing when sign-ups justify it. Self-hosting is supported as docs plus Docker Compose, with no install target and no support promise.
- **Evidence gates.** Set 2a starts only after 10 interviews (#33). Set 3 is re-ordered from what design partners actually asked for (#77).

## The sets

| Set                      | For whom                                                           | Exit goal                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MVP**                  | Founder + 3–5 design partners                                      | 10 interviews logged · 3 partners run the loop in shadow mode for 2 weeks · ≥50% of drafts approved unchanged · coding-agent spike decided (#69) |
| **2a: safe real mail**   | Design partners on hosted, real customer mail                      | 3 partners live (shadow mode off) · 5+ agent PRs merged from real tickets · 2+ partners ask to pay                                               |
| **2b: paid hosted**      | First paying customers                                             | 10 paying workspaces                                                                                                                             |
| **3: complete helpdesk** | Dev-led SaaS teams switching from Help Scout, Crisp or plain email | 50 paying workspaces · 70% still paying after 3 months                                                                                           |
| **4: platform + growth** | Growing teams, agent builders                                      | $5K MRR (about 170 workspaces at about $30 average)                                                                                              |
| **Later**                | Enterprise, more channels                                          | On demand                                                                                                                                        |

## MVP

A demo to learn from, not a release. **Shadow mode** (#66) sends every outbound email to the design partner instead of the customer, so the release-only safety items in Set 2a can wait.

Order:

1. #63 ignore auto-replies, bounces and mail loops
2. #45 AI draft → approve → send, with #64 daily AI spend cap
3. #65 email the owner when a draft is waiting
4. #16 SSRF-safe fetch
5. #61 knowledge base, drafts cite sources
6. #49 minimal agent tokens
7. #46 inbox screen with email + password login, sanitised customer HTML
8. #66 shadow mode
9. #37 ticket → GitHub issue → "fixed" notify
10. #67 demo instance
11. #69 manual coding-agent spike

Anytime: #62 this roadmap · #68 ADR on config in git (decision only).
Human, in parallel: #33 interviews (the first 10 gate Set 2a) · #34 landing page + waitlist.

Done: ✅ #5 run locally · ✅ #44 email → ticket · ✅ #48 AI test harness · ✅ #55 tenant-safe jobs · ✅ withTenant + RLS + basic leak tests · ✅ #36 ADR 0009 · ✅ #50 architecture overview · ✅ #42 required AI review.

## Set 2a: safe real mail

Shadow mode turns off at the end of this set. Everything in "safety" and "email" must be done first.

- **Wedge:** #70 GitHub App instead of a PAT · #71 many tickets → one issue, notify everyone affected · #72 coding agent opens the fix PR, approved and tracked (shape depends on #69) · #73 codebase-aware answers from the linked repo
- **Safety:** #13 policy layer, caps, kill switch, signed approvals · #31 SPF/DKIM/DMARC check · #8 full leak harness · #15 envelope encryption · #29 rate limiting · #52 output sanitisation + PII masking · #28 threat model, including the coding-agent path · #78 incident response + data retention
- **Email:** #74 custom sending domain, DKIM signing, attachments · #75 bounce handling, quote stripping
- **Team:** #11 invites, password reset, roles
- **Ops:** #18 #6 separate worker + worker DB role · #20 logs, error tracking, AI cost per workspace · #76 backup, restore, doctor · #21 production Docker + Compose · #23 release automation · #10 API conventions (before customers integrate)
- **Evidence:** #77 product usage events and weekly summary
- **Payment:** invoice or payment link for design partners (no billing code)

## Set 2b: paid hosted

- Hosted sign-up and onboarding: forward-your-support-email setup + DNS check
- Pricing page decision
- Usage metering (decide what counts as a "conversation") + AI-turn cap per conversation
- Stripe billing with Stripe Tax, plans, trial (build when there are 10+ sign-ups)
- Trial abuse and spam sign-up protection
- Privacy policy, DPA, subprocessor list · GDPR export/delete as a documented manual process
- Competitor comparison (Clanker Support, Plain, Chatbase) + "why switch" pages for Help Scout and Chatwoot users

## Set 3: complete helpdesk

Re-ordered from #77 data and design-partner requests before we start.

- **Inbox:** statuses (open, pending, snoozed, closed) · assignment · internal notes · tags · search · saved replies · customer profile + history · realtime + collision warning (`Broadcaster`) · 2FA · OAuth login (GitHub, Google)
- **Channels:** chat widget + identity-verified widget (only if interviews confirm demand) · IMAP inbound · create tickets through the API · #57 envelope-recipient routing
- **AI:** triage (category, priority, language, sentiment) · test mode (replay past tickets) · autopilot within allowed rules · handoff + escalation · bring your own key · #19 bring your own agent via MCP · teach v1 (one-click "make this reply an article")
- **Wedge:** customer-facing status page ("your bug is being fixed") · revenue-weighted feature requests v1 (manual MRR per customer)
- **Knowledge:** basic public help center from the knowledge base
- **Import:** email history (IMAP or mbox backfill)
- **Notifications:** Slack
- **Ops:** docs site (self-hosting + API) · status page · #24 seed data · #22 coverage and performance budgets in CI

## Set 4: platform + growth

- **Platform:** generated SDK (#19) · #12 token expiry, rotation, UI · #14 audit log query API · #17 outbound signed webhooks · #30 OpenSSF Scorecard · one-click deploy (Railway, Render) · audit log export
- **Wedge:** config, knowledge and policies in git (implementing #68) · revenue-weighted requests v2 (from Stripe) · Linear + Jira · changelog → notify the customers who asked
- **AI:** teach v2 (learn from human edits) · AI actions and tools (Stripe lookup, refund…) under the policy layer · multilingual replies
- **Inbox:** views + filters · bulk actions · keyboard shortcuts · merge and split · SLAs + business hours · companies + custom fields
- **Knowledge:** article editor · website import + scheduled re-crawl · AI answer box in the help center · help center custom domain · Notion, Confluence and docs-repo connectors
- **Automation and reports:** rules + triggers · routing · dashboard (volume, AI resolution rate, first response time) · CSAT
- **Business:** overage pricing · #25 CLA lawyer review (before large outside contributions)

## Later (on demand)

Import from Zendesk, Help Scout, Intercom · Slack Connect, Discord · WhatsApp, SMS, social, voice · SSO (SAML, OIDC), SCIM · mobile app + push · proactive outbound messages · multilingual help center · plugin system + marketplace · Helm, Kubernetes · SOC 2, data residency, IP allowlist
