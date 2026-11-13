# 0012. No help center: public content is knowledge articles

- Status: Accepted
- Date: 2026-11-13
- Supersedes: the help center row of ADR 0002 and the help center budget of ADR 0006

## Context

ADR 0002 picks a server-rendered help center (Hono JSX behind a CDN), and ADR 0006 gives it a Lighthouse performance budget of 95.

The [vision](../vision.md) has no help center. Knowledge is a store that serves cited answers. In the first ten minutes, a team adds its existing docs' URLs as knowledge sources, so the team already has a place where its docs are published.

## Decision

### 1. HelpOS has no help center

HelpOS doesn't render a public help center site, and it has no hosted chat page. It stores knowledge and serves it through the API, and through MCP once MCP ships. A team publishes articles where it already publishes docs, or has an agent publish them from the API.

Reason: a help center is a product of its own, with themes, search engine work and hosting. An agent with API access can publish articles anywhere in one prompt, so building one breaks the first rule ("pipes, not features").

The help center rows in ADR 0002 and ADR 0006 no longer apply. Nothing needs Hono JSX rendering or a Lighthouse budget.

### 2. Public content is knowledge articles

The only content HelpOS stores for customers to read is knowledge articles marked `public`. HelpOS stores no other kind of page.

Reason: one kind of public content means one place to keep current, cite and check for staleness.

### 3. The chat widget stays

Chat comes to customers only through the widget, an embeddable web component. ADR 0002's widget row and ADR 0006's widget budget (at most 20 KB gzipped) stand, and apply when the widget is built (#399).

## Rejected

- **Build the help center now.** It is a separate product, and it serves people reading docs, not the decisions the desk exists for.
- **Keep the help center rows for later.** A row for something we don't plan to build reads as a plan.

## Consequences

- Building a help center, a hosted chat page, or any public page type besides knowledge articles needs a new ADR.
