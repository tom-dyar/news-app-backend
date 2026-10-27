<!-- markdownlint-disable MD013 -->

# Triggering the news agent from outside

The agent can be started by an authenticated external caller. Runs happen in the background
(a full run takes one to three minutes), so the trigger returns immediately and you check
the result separately.

Base URL: `https://news-app-backend.tom-dyar.workers.dev`

## Endpoints

| Endpoint               | Auth                    | Purpose                                         |
| ---------------------- | ----------------------- | ----------------------------------------------- |
| `POST /trigger`        | `Authorization: Bearer` | Start a run. Returns `202` with a run ID.       |
| `GET /trigger/{runId}` | `Authorization: Bearer` | Run status: `queued`, `running`, `complete`, …  |
| `POST /slack/command`  | Slack request signature | Slack slash command (needs Slack setup, below). |
| `POST /agent`          | `Authorization: Bearer` | Run synchronously (waits for the result).       |

Without a valid token, `/trigger` and `/agent` return `401` for every method. `/trigger` and Slack
allow one run per 5 minutes (`429` with `Retry-After` otherwise), which stops a
looping automation from running up costs. If `TRIGGER_TOKEN` is not set on the Worker,
it returns `503` rather than running open.

## Your token

The token is stored in the project's local `.env` as `NEWS_TRIGGER_TOKEN` and on the Worker as
the secret `TRIGGER_TOKEN`. Treat it like a password: keep it in the caller's secret store,
never in client-side JavaScript or a public repo.

To rotate it:

```bash
NEW=$(openssl rand -hex 32)
printf '%s' "$NEW" | npx wrangler secret put TRIGGER_TOKEN
# then update NEWS_TRIGGER_TOKEN in .env and in every caller
```

## Calling it

### curl or any script

```bash
curl -X POST https://news-app-backend.tom-dyar.workers.dev/trigger \
  -H "Authorization: Bearer $NEWS_TRIGGER_TOKEN"
# {"status":"queued","runId":"cf_…","statusUrl":"https://…/trigger/cf_…"}

curl https://news-app-backend.tom-dyar.workers.dev/trigger/RUN_ID \
  -H "Authorization: Bearer $NEWS_TRIGGER_TOKEN"
# {"runId":"cf_…","status":"complete","output":{"inserted":6,"skipped":9,"totalReturned":15,…}}
```

### Zapier, Make, n8n, IFTTT (for example: "when an email arrives")

1. Trigger: **Email Parser / Email by Zapier** (or Gmail, Outlook, a schedule, a form, …).
2. Action: **Webhooks → POST** (Make: _HTTP → Make a request_).
3. URL: `https://news-app-backend.tom-dyar.workers.dev/trigger`
4. Header: `Authorization` = `Bearer <your token>`. No body is needed.

The call returns immediately, so the tool's own timeout is not an issue.

### GitHub Actions

```yaml
- name: Run news agent
  run: |
    curl --fail -X POST https://news-app-backend.tom-dyar.workers.dev/trigger \
      -H "Authorization: Bearer ${{ secrets.NEWS_TRIGGER_TOKEN }}"
```

### Slack slash command

Slack cannot send a bearer header, so it uses its own signed-request check instead.

1. Create an app at <https://api.slack.com/apps> and open **Slash Commands → Create New Command**.
2. Command: `/news`. Request URL: `https://news-app-backend.tom-dyar.workers.dev/slack/command`.
3. Install the app to your workspace.
4. Copy the **Signing Secret** (Basic Information) and store it on the Worker:

   ```bash
   printf '%s' "<signing secret>" | npx wrangler secret put SLACK_SIGNING_SECRET
   ```

5. Optional but recommended: limit who can run it. Any workspace member
   can use a slash command, and each run costs Anthropic credits.

   ```bash
   printf '%s' "U012ABCDE,U034FGHIJ" | npx wrangler secret put SLACK_ALLOWED_USERS
   ```

Typing `/news` then answers immediately ("Running the news agent now…")
and, when the run finishes, posts a summary of new and known articles to the
channel.

## How it is protected

- The bearer token is compared in constant time. Wrong, missing or malformed
  tokens get `401`.
- Slack requests must carry a valid HMAC signature and a timestamp within 5
  minutes, so replayed requests are rejected. Results are only posted to
  `hooks.slack.com` URLs.
- Nothing runs unless the matching secret is configured on the Worker.
