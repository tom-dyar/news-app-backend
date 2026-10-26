// Secrets are not in wrangler.jsonc, so `wrangler types` doesn't know them.
//   npx wrangler secret put ANTHROPIC_API_KEY
//   npx wrangler secret put TRIGGER_TOKEN          (bearer token for POST /trigger)
//   npx wrangler secret put SLACK_SIGNING_SECRET   (optional: enables POST /slack/command)
//   npx wrangler secret put SLACK_ALLOWED_USERS    (optional: comma-separated Slack user IDs)
interface Env {
	ANTHROPIC_API_KEY: string;
	TRIGGER_TOKEN?: string;
	SLACK_SIGNING_SECRET?: string;
	SLACK_ALLOWED_USERS?: string;
}
declare namespace Cloudflare {
	interface Env {
		ANTHROPIC_API_KEY: string;
		TRIGGER_TOKEN?: string;
		SLACK_SIGNING_SECRET?: string;
		SLACK_ALLOWED_USERS?: string;
	}
}
