# 0012. A headless help center: HelpOS stores and serves pages, each team renders its site

- Status: Accepted
- Date: 2026-11-13

## Context

Teams need public help content in their own design. The [vision](../vision.md) makes HelpOS responsible for storing and serving pages, while agents and teams build frontends through the public API and MCP. This keeps the core independent of a site's design and hosting.

## Decision

### 1. HelpOS stores help center pages and serves them through the API and MCP

HelpOS stores the public pages a team's customers read, and serves them through the API and MCP only. It ships no site, theme or page builder. Each team designs and renders its own help center from the API, with any site or static generator.

Help center pages build on the knowledge store, which already marks content `public` or `internal`. A published page and the knowledge an agent cites are one source. Agents write pages through the gate (ADR 0011). #405 builds the pages and the API.

Reason: storing and serving pages is a pipe. Rendering them is design work that each team does differently, and an agent with API access can build a site in one prompt.

### 2. Page reads use the API performance budget

A team's site performance is the team's to measure. HelpOS's API latency budget in [ADR 0006](0006-performance-budgets.md) covers page reads.

### 3. Chat uses an embeddable widget

Chat is planned under Later (#399). It reaches customers only through an embeddable web component, with its chat UI in a sandboxed iframe. HelpOS hosts no chat page. The widget follows ADR 0002 and the bundle budget in ADR 0006 when it is built.

## Rejected

- **No help center content at all.** Customers need public pages to read, and HelpOS already holds the knowledge they come from. Keeping both in one store means a page and a cited answer can't drift apart.

## Consequences

- Nothing built before #405 may assume a site rendered by HelpOS, or tie public content to a dashboard screen.
- A team needs its own site, or an agent to build one, before customers see pages.
- Frontends remain independent of the core, so teams can change their site's design without changing HelpOS.
