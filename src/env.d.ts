// Secrets are not in wrangler.jsonc, so `wrangler types` doesn't know them.
// Set with: npx wrangler secret put ANTHROPIC_API_KEY
interface Env {
	ANTHROPIC_API_KEY: string;
}
declare namespace Cloudflare {
	interface Env {
		ANTHROPIC_API_KEY: string;
	}
}
