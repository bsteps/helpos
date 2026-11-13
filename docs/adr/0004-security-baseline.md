# 0004. Security baseline for an agent-first product

- Status: Accepted
- Date: 2026-11-06

## Context

In HelpOS, AI agents read untrusted text (emails, chats, imported websites) and can take actions (refunds, account changes). Our agents, customers' agents, and end users' agents all touch the system. Security is the product, not a feature.

## Decision: required from the first release, never "later"

**Identity and access**

- Human sessions: Better Auth, pinned versions, advisories watched.
- Agent/API tokens: our own implementation. Prefixed (`hos_…`), stored hashed, scoped to exact permissions, revocable, one identity per agent (never shared).
- MCP: OAuth 2.1 with audience-bound tokens.
- End users are verified (signed widget identity or verified email) before the AI uses their account data.
- Inbound email: check **SPF/DKIM/DMARC before** trusting the sender's identity.

**Agent actions**

- Policy layer: write actions are **off by default**. Every agent passes one gate, with trust earned per agent and per action type. A person approves decisions and accepts promotions. Actions that cannot be undone start with human approval, and only a person can automate them with hard caps ([ADR 0011](0011-the-gate.md)).
- Approvals are signed. The exact approved action is hashed and checked when executed.
- Spend and action caps per agent and per tenant, hard AI cost caps per tenant, and a tenant-wide **kill switch**.
- Audit log of every human and agent action: who, what, when, why, and the inputs.

**Prompt injection and output**

- Inbound content (email, chat, imported pages, help articles) is treated as **data, never as instructions**. Tools are restricted by context.
- AI output is sanitised: no remote images, and links pass through an allowlist or proxy (this blocks data exfiltration through rendered markdown).
- PII is masked before text goes to the LLM.

**Platform**

- Tenant isolation as in ADR 0003.
- Secrets use envelope encryption (customer LLM keys and integration tokens).
- SSRF-safe fetch for imports and webhooks: private IP ranges are blocked and re-checked after DNS resolution.
- Email HTML is rendered in a sandboxed iframe. Strict CSP. The widget is isolated in an iframe.
- Rate limits and bot protection. Outbound send quotas so we can't be used to relay spam. Auto-reply loop and bounce handling.
- Webhooks are signed with HMAC and carry a timestamp with a replay window. Write endpoints take idempotency keys.
- Supply chain: Dependabot, dependency review (vulnerabilities + licences), secret scanning, CodeQL, and GitHub Actions pinned by commit SHA.

## Consequences

Every feature PR must state how it fits this baseline (see the PR template checklist). Security review is part of the definition of done.
