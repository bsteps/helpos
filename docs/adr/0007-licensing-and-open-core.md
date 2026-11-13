# 0007. AGPL-3.0 + CLA, private cloud repo

- Status: Accepted
- Date: 2026-11-06

## Decision

- **Licence: AGPL-3.0-only.** Anyone may use, modify and self-host for free. Anyone running a modified version as a network service must publish their changes. The UI has a "Source" link to satisfy AGPL §13.
- **CLA** (`CLA.md`, Apache-ICLA-style, with relicensing rights), collected by cla-assistant.io ([ADR 0008](0008-cla-assistant.md)). It must be **reviewed by a lawyer** before significant outside contributions are accepted.
- **Open-core boundary:** every helpdesk feature is public. Only the machinery of our hosted service (billing, multi-tenant admin, usage metering) lives in a **private `helpos-cloud` repo** that consumes the public packages.
- **Pledge:** core helpdesk features will stay AGPL. We will not move existing features behind a paywall.
- **Trademark:** the name and logo are not covered by the AGPL (see `TRADEMARK.md`).

## Consequences

- The private repo is only safe if every line of the public repo is ours or covered by a signed CLA. The CLA check is therefore a required status check.
- Some companies avoid AGPL. A commercial licence can be offered later thanks to the CLA.
