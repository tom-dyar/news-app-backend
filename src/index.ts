import { publicSummary, runAgent, type FetchTopicArticles } from "./agent";
import { fetchTopicArticles } from "./anthropic";
import { bearerMatches, verifySlackSignature } from "./auth";
import { queryArticles } from "./db";
import { claimRun } from "./runs";
import { isSevenAmEastern } from "./schedule";
import { resolveTopic } from "./topics";
import type { RunParams } from "./workflow";

export { NewsRunWorkflow } from "./workflow";

// Only the dashboard (and local dev) may read responses from a browser. Non-browser callers aren't affected by CORS,
// so the sensitive endpoints are protected by tokens and rate limits, not by this list.
const DASHBOARD_ORIGIN = "https://news-app-frontend.pages.dev";
const ALLOWED_ORIGIN = /^(https:\/\/([a-z0-9-]+\.)?news-app-frontend\.pages\.dev|http:\/\/localhost(:\d+)?)$/;

/** Minimum gap between runs started from the public dashboard button. */
const PUBLIC_REFRESH_GAP_SECONDS = 60 * 60;
/** Minimum gap between runs started through /trigger or Slack: stops a looping automation from running up costs. */
const AUTOMATION_GAP_SECONDS = 5 * 60;

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { ...extraHeaders, "Content-Type": "application/json; charset=utf-8" } });
}

/** Add CORS and hardening headers to every response, whichever route produced it. */
function withSecurityHeaders(request: Request, response: Response): Response {
	const origin = request.headers.get("Origin");
	const res = new Response(response.body, response);
	const h = res.headers;
	h.set("Access-Control-Allow-Origin", origin && ALLOWED_ORIGIN.test(origin) ? origin : DASHBOARD_ORIGIN);
	h.append("Vary", "Origin");
	h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
	h.set("Access-Control-Max-Age", "86400");
	h.set("X-Content-Type-Options", "nosniff");
	h.set("Referrer-Policy", "no-referrer");
	h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
	if (request.method !== "GET" && request.method !== "OPTIONS") h.set("Cache-Control", "no-store");
	return res;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s);

async function handleArticles(url: URL, env: Env): Promise<Response> {
	const p = url.searchParams;
	const bad = (error: string) => json({ error }, 400);

	let topic: string | undefined;
	if (p.has("topic")) {
		const resolved = resolveTopic(p.get("topic")!);
		if (!resolved) return bad("unknown topic");
		topic = resolved;
	}
	const from = p.get("from") ?? undefined;
	const to = p.get("to") ?? undefined;
	if ((from && !validDate(from)) || (to && !validDate(to))) return bad("from/to must be valid YYYY-MM-DD dates");

	let minScore: number | undefined;
	if (p.has("min_score")) {
		minScore = Number(p.get("min_score"));
		if (!Number.isInteger(minScore) || minScore < 1 || minScore > 10) return bad("min_score must be an integer 1-10");
	}
	let limit = 50;
	if (p.has("limit")) {
		limit = Number(p.get("limit"));
		if (!Number.isInteger(limit) || limit < 1 || limit > 200) return bad("limit must be an integer 1-200");
	}
	const source = p.get("source") || undefined;
	if (source && source.length > 100) return bad("source must be at most 100 characters");

	const articles = await queryArticles(env.DB, { topic, from, to, source, minScore, limit });
	return json({ count: articles.length, articles });
}

export interface RunStatus {
	status: string;
	output?: unknown;
	error?: unknown;
}

export interface Deps {
	fetchTopicArticles: FetchTopicArticles;
	/** Start a background pipeline run; resolves to its id. */
	startRun?: (env: Env, params: RunParams) => Promise<string>;
	/** Look up a background run; null when the id is unknown. */
	getRun?: (env: Env, id: string) => Promise<RunStatus | null>;
}

const startWorkflowRun = async (env: Env, params: RunParams) => (await env.NEWS_RUN.create({ params })).id;

async function getWorkflowRun(env: Env, id: string): Promise<RunStatus | null> {
	try {
		return await (await env.NEWS_RUN.get(id)).status();
	} catch {
		return null;
	}
}

const SLACK_RESPONSE_URL = /^https:\/\/hooks\.slack\.com\//;

/** Returns an error Response when the caller isn't authorized, else null. Fails closed if no token is configured. */
async function requireToken(request: Request, env: Env): Promise<Response | null> {
	if (!env.TRIGGER_TOKEN) return json({ error: "trigger is not configured" }, 503);
	if (await bearerMatches(request.headers.get("Authorization"), env.TRIGGER_TOKEN)) return null;
	return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="news-app-backend"' });
}

const tooSoon = (retryAfterSeconds: number) => json({ error: "a run started recently", retryAfterSeconds }, 429, { "Retry-After": String(retryAfterSeconds) });

export function createHandler(deps: Deps) {
	const startRun = deps.startRun ?? startWorkflowRun;
	const getRun = deps.getRun ?? getWorkflowRun;

	async function handleSlack(request: Request, env: Env): Promise<Response> {
		if (!env.SLACK_SIGNING_SECRET) return json({ error: "slack integration is not configured" }, 503);
		const body = await request.text();
		const valid = await verifySlackSignature(env.SLACK_SIGNING_SECRET, request.headers.get("X-Slack-Request-Timestamp"), request.headers.get("X-Slack-Signature"), body);
		if (!valid) return json({ error: "invalid signature" }, 401);

		const form = new URLSearchParams(body);
		const userId = form.get("user_id") ?? "";
		const allowed = (env.SLACK_ALLOWED_USERS ?? "").split(",").map((u) => u.trim()).filter(Boolean);
		if (allowed.length > 0 && !allowed.includes(userId)) {
			return json({ response_type: "ephemeral", text: "Sorry, you're not authorized to run the news agent." });
		}
		const claim = await claimRun(env.DB, `slack:${userId}`, AUTOMATION_GAP_SECONDS);
		if (!claim.claimed) {
			return json({ response_type: "ephemeral", text: `The news agent already ran recently. Try again in ${Math.ceil(claim.retryAfterSeconds / 60)} min.` });
		}
		const responseUrl = form.get("response_url") ?? "";
		await startRun(env, { source: `slack:${userId}`, ...(SLACK_RESPONSE_URL.test(responseUrl) && { responseUrl }) });
		// Slack requires a reply within 3 seconds; the finished report is posted to response_url by the workflow.
		return json({ response_type: "ephemeral", text: "Running the news agent now. I'll post the results here in about a minute." });
	}

	async function route(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const isPost = request.method === "POST";
		const notAllowed = () => json({ error: "method not allowed" }, 405);

		switch (url.pathname) {
			case "/health":
				return json({ status: "ok", service: "news-app-backend", timestamp: new Date().toISOString() });
			case "/articles":
				return request.method === "GET" ? handleArticles(url, env) : notAllowed();
			case "/refresh": {
				// Public (the dashboard's Refresh button), so it is rate limited and reveals only counts.
				if (!isPost) return notAllowed();
				const claim = await claimRun(env.DB, "public", PUBLIC_REFRESH_GAP_SECONDS);
				if (!claim.claimed) return tooSoon(claim.retryAfterSeconds);
				return json(publicSummary(await runAgent(env, deps.fetchTopicArticles)));
			}
			case "/agent": {
				// Synchronous run for the token holder, with full detail.
				if (!isPost) return notAllowed();
				const denied = await requireToken(request, env);
				if (denied) return denied;
				await claimRun(env.DB, "agent", 0);
				return json(await runAgent(env, deps.fetchTopicArticles));
			}
			case "/trigger": {
				if (!isPost) return notAllowed();
				const denied = await requireToken(request, env);
				if (denied) return denied;
				const claim = await claimRun(env.DB, "trigger", AUTOMATION_GAP_SECONDS);
				if (!claim.claimed) return tooSoon(claim.retryAfterSeconds);
				const runId = await startRun(env, { source: "trigger" });
				return json({ status: "queued", runId, statusUrl: `${url.origin}/trigger/${runId}` }, 202);
			}
			case "/slack/command":
				return isPost ? handleSlack(request, env) : notAllowed();
			default: {
				if (url.pathname.startsWith("/trigger/")) {
					if (request.method !== "GET") return notAllowed();
					const denied = await requireToken(request, env);
					if (denied) return denied;
					const runId = decodeURIComponent(url.pathname.slice("/trigger/".length));
					const run = await getRun(env, runId);
					return run ? json({ runId, ...run }) : json({ error: "run not found" }, 404);
				}
				return json({ error: "not found", endpoints: ["/health", "/articles", "/refresh"] }, 404);
			}
		}
	}

	return {
		async fetch(request: Request, env: Env): Promise<Response> {
			if (request.method === "OPTIONS") return withSecurityHeaders(request, new Response(null, { status: 204 }));
			let response: Response;
			try {
				response = await route(request, env);
			} catch (err) {
				console.error("unhandled error:", err);
				response = json({ error: "internal error" }, 500);
			}
			return withSecurityHeaders(request, response);
		},

		async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
			// Triggered at 11:00 and 12:00 UTC; only the run that is 7 AM in New York proceeds (handles DST).
			if (!isSevenAmEastern(new Date(controller.scheduledTime))) return;
			await claimRun(env.DB, "cron", 0);
			ctx.waitUntil(
				runAgent(env, deps.fetchTopicArticles).then((s) => console.log(`scheduled agent: inserted=${s.inserted} skipped=${s.skipped} returned=${s.totalReturned}`)),
			);
		},
	} satisfies ExportedHandler<Env>;
}

export default createHandler({ fetchTopicArticles });
