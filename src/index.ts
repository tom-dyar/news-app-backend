import { runAgent, type FetchTopicArticles } from "./agent";
import { fetchTopicArticles } from "./anthropic";
import { bearerMatches, verifySlackSignature } from "./auth";
import { queryArticles } from "./db";
import { isSevenAmEastern } from "./schedule";
import { resolveTopic } from "./topics";
import type { RunParams } from "./workflow";

export { NewsRunWorkflow } from "./workflow";

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
	"Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, ...extraHeaders, "Content-Type": "application/json; charset=utf-8" } });
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

	const articles = await queryArticles(env.DB, { topic, from, to, source: p.get("source") || undefined, minScore, limit });
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
		const responseUrl = form.get("response_url") ?? "";
		await startRun(env, { source: `slack:${userId}`, ...(SLACK_RESPONSE_URL.test(responseUrl) && { responseUrl }) });
		// Slack requires a reply within 3 seconds; the finished report is posted to response_url by the workflow.
		return json({ response_type: "ephemeral", text: "Running the news agent now. I'll post the results here in about a minute." });
	}

	return {
		async fetch(request: Request, env: Env): Promise<Response> {
			if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
			const url = new URL(request.url);
			try {
				switch (url.pathname) {
					case "/health":
						return json({ status: "ok", service: "news-app-backend", timestamp: new Date().toISOString() });
					case "/agent":
						if (request.method !== "GET" && request.method !== "POST") return json({ error: "method not allowed" }, 405);
						return json(await runAgent(env, deps.fetchTopicArticles));
					case "/articles":
						if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
						return await handleArticles(url, env);
					case "/trigger": {
						if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
						const denied = await requireToken(request, env);
						if (denied) return denied;
						const runId = await startRun(env, { source: "trigger" });
						return json({ status: "queued", runId, statusUrl: `${url.origin}/trigger/${runId}` }, 202);
					}
					case "/slack/command":
						if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
						return await handleSlack(request, env);
					default:
						if (url.pathname.startsWith("/trigger/")) {
							if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
							const denied = await requireToken(request, env);
							if (denied) return denied;
							const runId = decodeURIComponent(url.pathname.slice("/trigger/".length));
							const run = await getRun(env, runId);
							return run ? json({ runId, ...run }) : json({ error: "run not found" }, 404);
						}
						return json({ error: "not found", endpoints: ["/health", "/agent", "/articles", "/trigger", "/slack/command"] }, 404);
				}
			} catch (err) {
				console.error("unhandled error:", err);
				return json({ error: "internal error" }, 500);
			}
		},

		async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
			// Triggered at 11:00 and 12:00 UTC; only the run that is 7 AM in New York proceeds (handles DST).
			if (!isSevenAmEastern(new Date(controller.scheduledTime))) return;
			ctx.waitUntil(
				runAgent(env, deps.fetchTopicArticles).then((s) => console.log(`scheduled agent: inserted=${s.inserted} skipped=${s.skipped} returned=${s.totalReturned}`)),
			);
		},
	} satisfies ExportedHandler<Env>;
}

export default createHandler({ fetchTopicArticles });
