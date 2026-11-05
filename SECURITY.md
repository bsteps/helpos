# Security Policy

HelpOS stores customer conversations and lets AI agents take actions, so we take security seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub instead: go to the **Security** tab → **Report a vulnerability**. Only the maintainers can see the report.

Please include:

- what the problem is and what someone could do with it
- steps to reproduce it (a proof of concept, if you have one)
- the affected version or commit

## What to expect

| Step                                            | Target time                                 |
| ----------------------------------------------- | ------------------------------------------- |
| We confirm we received your report              | 3 days                                      |
| First assessment (severity, whether it's valid) | 7 days                                      |
| Fix released for critical issues                | as fast as possible, usually within 30 days |

We'll credit you in the release notes unless you'd rather stay anonymous.

## Supported versions

HelpOS is pre-1.0 and has no releases yet. Security fixes land on `main`. After the first release, only the latest release gets security fixes.

## Scope

Especially welcome: cross-tenant data access, authentication or token bypass, prompt injection that leads to unauthorised actions, SSRF, and stored XSS in email rendering.
