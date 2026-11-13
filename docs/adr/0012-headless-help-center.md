# 0012. A headless help center: HelpOS stores and serves pages, each team renders its site

- Status: Accepted
- Date: 2026-11-13
- Supersedes: the help center row of ADR 0002 and the help center budget of ADR 0006

## Context

ADR 0002 picks a help center that HelpOS renders on the server (Hono JSX behind a CDN), and ADR 0006 gives it a Lighthouse performance budget of 95.

The [vision](../vision.md) says HelpOS stores the nouns (replies, tags, articles, pages and data) and agents do the verbs (rule 7). It also says HelpOS builds pipes, not features (rule 0). A site with themes, layouts and search engine work is a feature every team wants to design its own way.

## Decision

### 1. HelpOS stores help center pages and serves them through the API and MCP

HelpOS stores the public pages a team's customers read, and serves them through the API and MCP only. It ships no site, theme or page builder. Each team designs and renders its own help center from the API, with any site or static generator.

Help center pages build on the knowledge store, which already marks content `public` or `internal`. A published page and the knowledge an agent cites are one source. Agents write pages through the gate (ADR 0011). #405 builds the pages and the API.

Reason: storing and serving pages is a pipe. Rendering them is design work that each team does differently, and an agent with API access can build a site in one prompt.

### 2. HelpOS has no rendered site and no Lighthouse budget

The help center rows in ADR 0002 and ADR 0006 no longer apply. HelpOS renders no pages with Hono JSX and has no Lighthouse budget of its own. A team's site performance is the team's to measure. HelpOS keeps the API latency budget in ADR 0006, which covers the page reads.

### 3. The chat widget stays

Chat reaches customers only through the widget, an embeddable web component. HelpOS hosts no chat page. ADR 0002's widget row and ADR 0006's widget budget (at most 20 KB gzipped) stand, and apply when the widget is built (#399).

## Rejected

- **Render the help center in HelpOS.** It is a separate product with themes, layouts and hosting, and every team would want to change it.
- **No help center content at all.** Customers need public pages to read, and HelpOS already holds the knowledge they come from. Keeping both in one store means a page and a cited answer can't drift apart.

## Consequences

- Nothing built before #405 may assume a site rendered by HelpOS, or tie public content to a dashboard screen.
- A team needs its own site, or an agent to build one, before customers see pages.
- Rendering a help center inside HelpOS later needs a new ADR.
