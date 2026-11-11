# Vision

> **A helpdesk that runs and improves itself. You approve.**

HelpOS is the **desk**, not the worker. AI agents (ours, or the team's own) do the support work at the desk. People decide, correct and teach. The desk makes that safe, fast and visible.

## The picture

```
            ┌──────────────── HelpOS (the desk) ────────────────┐
customer ─▶ │ conversations · customers · knowledge · playbook  │
            │ queues · waiting lists · events · audit log       │
            │                                                   │
            │  THE GATE: every action an agent wants is checked │
            │  trusted → done now   ·   not yet → your queue    │
            └──────▲─────────────────────────────▲──────────────┘
                   │ inside, always on           │ API / MCP, when they run
          Built-in agent                   The team's own agents
          (their AI key, or ours included) (Claude Code, Codex, custom…)
```

## Who it's for and why

**Any product company, any size.** With AI, a small team can run support that used to need a big one.

Today's helpdesks are huge systems built for a human to set up, read and operate, and nobody really does:

- support relays bugs to developers over chat, and the bugs get forgotten
- customers leave out screenshots and repro steps
- "it's fixed" is sent by hand, or never
- the knowledge base goes stale and the AI makes things up
- the features and analytics go unused because nobody has time to work out what to do with them

HelpOS lets an agent operate the desk, and the desk keeps the agent safe.

## The two loops

1. **Work:** agents handle conversations around the clock.
2. **Improve:** an agent operates the desk itself: the built-in agent on a schedule, or your own agent through MCP, using the same skills. It sets things up, keeps the knowledge fresh, reads the data, finds bottlenecks and proposes fixes. Each proposal lands in your queue.

## The rules to remember

0. **Pipes, not features.** If an agent can do it in one prompt, we don't build it. We make the pipes strong, fast and light.
1. **Agents propose, the desk decides.** Every action taken through HelpOS passes one gate, whether the agent is ours or yours. An outside agent acting elsewhere with its own keys is outside the gate. To govern an action on an outside tool, route it through HelpOS's tool connections.
2. **Inbox zero means zero decisions, not zero tickets.** The home screen is the decision queue.
3. **Trust is earned per agent and per action type, from outcomes.** Approvals without edits, and customers who don't come back unhappy, move an action up the ladder. Corrections and unhappy returns move it down. Unknown outcomes never earn trust. Approving a decision and accepting a promotion are always done by a person.
4. **Ask once, remember, recheck.** When unsure, ask. Your answer becomes a rule. Rules and knowledge are rechecked whenever the product changes or answers start going wrong.
5. **One writer at a time, always on the latest version, and nothing is resent automatically.** Each conversation has one owner whose claim expires, and stale proposals are rejected. When it's unclear whether something went out, a person decides.
6. **Mistakes are expected, so they must be cheap, visible and reversible.** Everything is audited and internal changes can be undone. Actions that can't be undone (money, deletions, outbound email) always start at "you approve". Only a person can automate them, and only with hard caps.
7. **We store the nouns, agents do the verbs.** HelpOS stores and serves replies, tags, articles, pages and data. Agents decide what goes in them.
8. **The desk teaches agents.** Skills ship over MCP, and new features announce themselves through the agent.
9. **No source, no answer.** Factual claims need a source. Questions and acknowledgments don't. A missing source becomes a knowledge gap, ranked by how many customers hit it, never a guess.
10. **Customers always know it's AI, and can always reach a person.** This is guaranteed by the desk, not by a prompt.

## The first 10 minutes

1. Forward your support email.
2. Upload your old helpdesk's export and point HelpOS at your docs. The built-in agent maps the export with the migration skill.
3. **Shadow mode** (the bottom rung of the trust ladder): the agent drafts everything and sends nothing to customers (replies go to you). Within minutes of the import, the desk shows "here's how I'd have answered your last 200 conversations".
4. Turn on live replies, with a person approving each one. Promote only after real outcomes show what you can trust.

## The one number

**Fewer decisions, customers just as happy.** Human decisions per 100 conversations go down, while customers coming back unhappy doesn't go up and sampled quality checks keep passing. Silence isn't proof: a customer who gave up didn't come back happy. Every decision counts, including the desk's own proposals, so an improve loop that makes more work than it saves shows up here.

## What we build (the pipes)

- **Channels in and out:** email first, then chat and the rest.
- **Conversations, customers, search.**
- **Knowledge store** with cited answers.
- **The gate:** decision queue, trust ladder, per-agent permissions, audit, kill switch, cost caps.
- **Coordination:** ownership claims, queues, handoffs.
- **Waiting lists:** customers waiting on the same fix, all told when it's done.
- **Wake-ups:** events, signed webhooks, an event feed, scheduled wake-ups.
- **The playbook:** written rules that humans and agents keep up to date.
- **Bulk import:** conversations, customers and articles, keeping threads and dates, and safe to run twice.
- **Staying current:** change events (release, deploy, fix shipped), cited answers, and versioned rules and knowledge with staleness checks.
- **Agent access:** API, MCP (we connect out to any tool's MCP server, gated by policy), skills.
- **Tenant isolation and security underneath everything.**
- **Day-one interface:** one small page (the decision queue plus the conversation it's about), with alerts in Slack and email. The full dashboard comes last, and the agent shapes it.

## What we don't build

- Coding fixes. The team fixes its own bugs, and we tell the customers.
- Tracker connectors. Agents use the tracker's own tools, and we own the waiting list.
- Per-platform importers. A migration skill lets the agent map Crisp, Zendesk or anything else into our bulk import.
- A coordinator. It's just an agent with permission to assign.
- Reports and screens for every feature. Agents read the data.

## Money and licence

- **The desk** is priced on one slider (by conversations), with every feature on every plan.
- **AI is included** up to a fair allowance per conversation, so there's one price. Bring your own key any time, for the same price: it just removes the allowance. AI isn't where we make money.
- **The team's own agents** cost us nothing.
- **AGPL open source**, free to self-host. You can loosen a licence later, but you can't tighten it.

## The test for any new idea

1. Is it a pipe, or one prompt away? If it's one prompt away, don't build it.
2. Does it go through the gate?
3. Does it make the desk better at running and improving itself?
