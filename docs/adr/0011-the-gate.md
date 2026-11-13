# 0011. The gate: one check for every agent, trust earned from outcomes

- Status: Accepted
- Date: 2026-11-13

## Context

Every agent needs permissions, limits and trust that reflect its own outcomes. The [vision](../vision.md) requires one gate for all agents, so the same controls apply to the built-in agent and a team's own agents. The [threat model](../security/threat-model.md) names its guarantees (`G1` to `G12`).

[ADR 0004](0004-security-baseline.md) sets the security baseline. Write actions are off by default, approvals are signed and checked against the exact action, spend and action caps apply per agent and per workspace, the kill switch exists, and every action is audited.

## Decision

### 1. One gate for every agent

Every action taken through HelpOS passes the same gate before it runs, whichever agent asks: the built-in agent, or one of the team's own agents through the API or MCP. The built-in agent is an agent like any other, with its own identity, permissions, trust and kill switch. No agent action is recorded as `system`. No worker, job or built-in path acts for an agent around the gate.

A job that carries out what was already decided, such as sending an approved reply, is not an agent and runs as `system`.

Reason: one gate is one place to grant, cap, stop and audit. A second path is where an injected instruction gets through, and an agent outside the gate can't be capped, stopped or demoted on its own.

### 2. The gate answers per agent and per action type

Each agent may take only the action types, and touch only the queues, that a person granted it. A new agent, a new action type or a new permission can do nothing until then.

For an action the agent may take, the gate answers from the agent's trust for that action type. If the agent is trusted for it, the action runs now. If not, it goes to the decision queue for a person.

Reason: an agent that writes good replies has shown nothing about refunds. Trust held per agent and per action type lets each one move on its own record.

### 3. Trust is earned from outcomes, and a person accepts each promotion

Outcomes move trust:

- Approvals without edits, and customers who don't come back unhappy, count toward a promotion.
- Edits, rejections and customers who come back unhappy move trust down, on their own and at once.
- Unknown outcomes count for nothing. A customer who stopped replying didn't come back happy.

The desk proposes a promotion when the outcomes earn it. Only a person accepts it.

Reason: outcomes are the only evidence of what an agent can be trusted with. A person's yes on each promotion stops an agent from earning trust by gaming its own outcomes, for example by closing conversations early so no one comes back unhappy.

### 4. Deciding is human-only

Only a person can:

- approve a decision
- accept a promotion
- turn a kill switch off
- change an agent's permissions, caps or trust
- create or change tokens and credentials
- cancel a customer's request for a person

An agent may turn a kill switch on and revoke its own token, nothing more. What a token can hold enforces this, not a prompt: no agent token can hold a scope that approves, promotes or changes limits.

Reason: an agent that can approve its own proposals, or raise its own limits, has no gate. A fooled agent follows injected text, so the limit has to sit in what its token allows.

### 5. Actions that can't be undone start at "you approve"

Actions that can't be undone (money, deletions and outbound email) start at "you approve" for every agent. Only a person can automate one of them, and only with hard caps, such as an amount per action and a total per day. The caps hold at every trust level.

Reason: a mistake that can't be undone has to be rare and small. Outcomes show an agent is good at an action. They don't show that the next mistake will be cheap, so a person sets the ceiling.

### 6. Caps and the kill switch win at every trust level

A kill switch stops new and pending actions. Caps limit what a trusted action may do. No trust level lifts either one.

### 7. Rules never widen authority on their own

A rule or setting that raises a cap, widens a permission or removes an approval step takes effect only after a person approves it. This holds whatever wrote it: a person's answer to a question, an agent, or a file in git (ADR 0010). A change that tightens takes effect at once.

Reason: if a rule could loosen the gate, a fooled agent could write the rule that frees it.

### 8. Every gate decision is audited

The audit log records each gate decision with its reason and inputs: the action ran, became a decision, or was refused.

## Rejected

- **Trust per agent only.** Good at replies says nothing about refunds.
- **Promotions that apply without a person.** Outcomes can be gamed, and nobody would see the agent's authority grow.
- **A separate path for the built-in agent.** It would be the one agent that nobody can cap, stop or demote on its own.

## Consequences

- Every agent starts at the bottom, so a new workspace sees more decisions at first. The one number in the vision (human work per 100 conversations) shows whether trust grows fast enough to pay that back.
- The draft worker becomes the built-in agent, with its own identity, instead of writing as `system`.
- `drafts:approve` and any other scope that decides becomes human-only. Agent tokens that hold it today lose it.
- The gate issues prove each rule with tests: #13 (one gate, identity, human-only), #166 (the trust ladder), #167 (rules can't widen authority) and #188 (caps and the kill switch). The threat model's `G1` to `G12` name the cases.
