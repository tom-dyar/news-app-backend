<!-- markdownlint-disable MD013 -->

# Security notes

## What is public, and what is protected

| Endpoint              | Who can call it                | Limits                                           |
| --------------------- | ------------------------------ | ------------------------------------------------ |
| `GET /health`         | Anyone                         | Read-only                                        |
| `GET /chat/models`    | Anyone                         | Read-only list of selectable models              |
| `GET /articles`       | Anyone                         | Read-only, validated parameters                  |
| `POST /agent`         | Bearer token                   | Full detail. Logged.                             |
| `POST /chat`          | Bearer token (the password)    | Uses Anthropic credits. Body limited to 64 KB.   |
| `POST /trigger`       | Bearer token                   | One run per 5 minutes                            |
| `GET /trigger/{id}`   | Bearer token                   | Read-only                                        |
| `POST /slack/command` | Signed by Slack, optional list | One run per 5 minutes                            |
| Daily 7 AM cron       | Cloudflare scheduler           | Always runs, and counts against the limits above |

All limits come from one run log in the database (`agent_runs`). A run claims its slot
with a single SQL statement, so simultaneous requests cannot both start a run.

## Controls

- **Secrets** are Worker secrets (`ANTHROPIC_API_KEY`, `TRIGGER_TOKEN`, and optionally
  `SLACK_SIGNING_SECRET`, `SLACK_ALLOWED_USERS`). None are in code or git history. The
  local `.env` is mode 600. Endpoints that need a secret return `503` if it is unset, so
  they never fall back to being open.
- **Token checks** use constant-time comparison. Slack requests are verified by HMAC
  signature with a 5-minute replay window, and results are only posted to `hooks.slack.com`.
- **CORS** allows only the dashboard origin (and `localhost` for development), never `*`.
- **Responses** carry `nosniff`, `Referrer-Policy: no-referrer`, a deny-all CSP, and
  `no-store` on anything that is not a plain GET.
- **The pipeline cannot be run anonymously.** There is no public way to start a run; `/health` and `/articles` are the only open endpoints and are read-only.
- **SQL** is fully parameterized. `LIKE` filters escape wildcards. Query inputs are
  validated and length-limited.
- **Untrusted web content**: article text comes from web pages that Claude read, so it is
  length-capped, only `http(s)` links are kept, and the dashboard renders it with
  `textContent` (never as HTML). The dashboard also sends a strict CSP.
- **Dependencies**: `npm audit` reports no known vulnerabilities in either repo. GitHub
  secret scanning and push protection are enabled on both repos.

## Risks that remain

- **The password is stored in the owner's browser** (`localStorage`) after the first Refresh, so anyone using that browser can refresh. The dashboard page itself never contains it, and the CSP blocks inline and third-party scripts. Use "Refresh" on a shared computer only if you are comfortable with that, or clear site data afterwards.
- **The Cloudflare API token in `.env`** is probably broader than the deploy needs.
  Replace it with a token limited to Workers Scripts, D1 and Pages edit permissions for
  this account.
- **Prompt injection**: a malicious web page could try to steer Claude's answer. Claude
  has only the web search tool, so the damage is limited to a misleading article card.
  Treat summaries as untrusted.
- **No request-level rate limit** per IP. Cloudflare WAF rate limiting rules can add one
  if the endpoints ever see abuse.
- **Rotate secrets** (`TRIGGER_TOKEN`, Slack signing secret) if they may have been exposed.
  The rotation steps are in `external-trigger.md`.
