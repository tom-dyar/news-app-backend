import { runAgent, type FetchTopicArticles } from "./agent";
import { fetchTopicArticles, streamChat as streamClaudeChat } from "./anthropic";
import { bearerMatches, verifySlackSignature } from "./auth";
import { ChatError, buildMessages, contextStats, matchesQuestion, parseChatRequest, selectContext, sseEvent, systemPrompt, type ChatCall, type ChatEvent, type WebSource } from "./chat";
import { queryArticles } from "./db";
import { DEFAULT_MODEL_ALIAS, MODELS } from "./models";
import { claimRun } from "./runs";
import { isSevenAmEastern } from "./schedule";
import { resolveTopic } from "./topics";
import type { RunParams } from "./workflow";

export { NewsRunWorkflow } from "./workflow";

// Only the dashboard (and local dev) may read responses from a browser. Non-browser callers aren't affected by CORS,
// so the sensitive endpoints are protected by tokens and rate limits, not by this list.
const DASHBOARD_ORIGIN = "https://news-app-frontend.pages.dev";
const ALLOWED_ORIGIN = /^(https:\/\/([a-z0-9-]+\.)?news-app-frontend\.pages\.dev|http:\/\/localhost(:\d+)?)$/;

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
	/** Stream an answer from Claude. Throws ChatError for failures before streaming starts. */
	streamChat?: (env: Env, call: ChatCall) => Promise<AsyncIterable<ChatEvent>>;
}

/** Chat requests are small; refuse anything larger without parsing it. */
const MAX_CHAT_BODY_BYTES = 64 * 1024;
/** How many of the newest stored articles are considered when picking context (the database keeps ~20 per topic). */
const CHAT_CANDIDATES = 100;
const NO_ARTICLES_ANSWER = "There are no articles in the database yet. Run a refresh to collect recent news, then ask again.";

const SSE_HEADERS = { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" };

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
	const streamChat = deps.streamChat ?? streamClaudeChat;

	async function handleChat(request: Request, env: Env): Promise<Response> {
		const raw = Number(request.headers.get("Content-Length")) > MAX_CHAT_BODY_BYTES ? null : await request.text();
		if (raw === null || raw.length > MAX_CHAT_BODY_BYTES) return json({ error: "request body too large" }, 413);
		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch {
			return json({ error: "request body must be valid JSON" }, 400);
		}
		const parsed = parseChatRequest(body);
		if (!parsed.ok) return json({ error: parsed.error }, 400);
		const { question, model, history, topic, maxArticles, stream, webSearch } = parsed.value;

		const candidates = await queryArticles(env.DB, { topic, limit: CHAT_CANDIDATES });
		const articles = selectContext(candidates, question, maxArticles);
		const context = contextStats(articles, candidates.length);
		const sources = articles.map((a, i) => ({ n: i + 1, id: a.id, headline: a.headline, source: a.source, url: a.url, published_at: a.published_at, topic: a.topic, relevance_score: a.relevance_score }));

		// Pull the first event before committing to a 200 so a rejected request becomes a proper HTTP error.
		let events: AsyncGenerator<ChatEvent, void, undefined>;
		if (articles.length === 0 && !webSearch) {
			events = (async function* (): AsyncGenerator<ChatEvent, void, undefined> {
				yield { type: "delta", text: NO_ARTICLES_ANSWER };
				yield { type: "done", stopReason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 }, model: model.id };
			})();
		} else {
			try {
				const today = new Date().toISOString().slice(0, 10);
				const loose = !articles.some((a) => matchesQuestion(a, question));
				const call: ChatCall = { model, webSearch, system: systemPrompt(webSearch), messages: buildMessages(history, articles, question, today, loose) };
				const iterator = (await streamChat(env, call))[Symbol.asyncIterator]();
				const first = await iterator.next();
				events = (async function* (): AsyncGenerator<ChatEvent, void, undefined> {
					if (!first.done) yield first.value;
					for (let next = await iterator.next(); !next.done; next = await iterator.next()) yield next.value;
				})();
			} catch (err) {
				if (err instanceof ChatError) return json({ error: err.message }, err.status === 429 ? 429 : 502);
				return json({ error: "The model request failed. Try again, or choose a different model." }, 502);
			}
		}

		if (!stream) {
			let answer = "";
			const searches: string[] = [];
			const webSources: WebSource[] = [];
			let done: Extract<ChatEvent, { type: "done" }> | undefined;
			try {
				for await (const e of events) {
					if (e.type === "delta") answer += e.text;
					else if (e.type === "search") searches.push(e.query);
					else if (e.type === "web_sources") webSources.push(...e.sources);
					else done = e;
				}
			} catch (err) {
				console.error("chat: stream failed:", err);
				return json({ error: "The model response was interrupted. Try again." }, 502);
			}
			return json({ answer, sources, context, webSearch, searches, webSources, model: done?.model ?? model.id, stopReason: done?.stopReason ?? null, usage: done?.usage });
		}

		const encoder = new TextEncoder();
		async function* frames(): AsyncGenerator<string> {
			yield sseEvent("meta", { model: model.id, sources, context, webSearch });
			try {
				for await (const e of events) {
					if (e.type === "delta") yield sseEvent("delta", { text: e.text });
					else if (e.type === "search") yield sseEvent("search", { query: e.query });
					else if (e.type === "web_sources") yield sseEvent("web_sources", { sources: e.sources });
					else yield sseEvent("done", { stopReason: e.stopReason, usage: e.usage, model: e.model });
				}
			} catch (err) {
				console.error("chat: stream failed:", err);
				yield sseEvent("error", { message: "The response was interrupted. Try again." });
			}
		}
		const gen = frames();
		return new Response(
			new ReadableStream<Uint8Array>({
				async pull(controller) {
					const next = await gen.next();
					next.done ? controller.close() : controller.enqueue(encoder.encode(next.value));
				},
				cancel: () => void gen.return(undefined),
			}),
			{ headers: SSE_HEADERS },
		);
	}

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
			case "/agent": {
				// Synchronous run, only for callers that present the password. Auth comes before the method check
				// so an unauthenticated request always gets 401, never a hint about what the endpoint accepts.
				const denied = await requireToken(request, env);
				if (denied) return denied;
				if (!isPost) return notAllowed();
				await claimRun(env.DB, "agent", 0);
				return json(await runAgent(env, deps.fetchTopicArticles));
			}
			case "/trigger": {
				const denied = await requireToken(request, env);
				if (denied) return denied;
				if (!isPost) return notAllowed();
				const claim = await claimRun(env.DB, "trigger", AUTOMATION_GAP_SECONDS);
				if (!claim.claimed) return tooSoon(claim.retryAfterSeconds);
				const runId = await startRun(env, { source: "trigger" });
				return json({ status: "queued", runId, statusUrl: `${url.origin}/trigger/${runId}` }, 202);
			}
			case "/slack/command":
				return isPost ? handleSlack(request, env) : notAllowed();
			case "/chat": {
				// Costs Anthropic credits, so it needs the same password as the pipeline.
				const denied = await requireToken(request, env);
				if (denied) return denied;
				return isPost ? handleChat(request, env) : notAllowed();
			}
			case "/chat/models":
				return json({ default: DEFAULT_MODEL_ALIAS, models: MODELS.map(({ alias, id, label }) => ({ alias, id, label })) });
			default: {
				if (url.pathname.startsWith("/trigger/")) {
					if (request.method !== "GET") return notAllowed();
					const denied = await requireToken(request, env);
					if (denied) return denied;
					const runId = decodeURIComponent(url.pathname.slice("/trigger/".length));
					const run = await getRun(env, runId);
					return run ? json({ runId, ...run }) : json({ error: "run not found" }, 404);
				}
				return json({ error: "not found", endpoints: ["/health", "/articles", "/chat/models"] }, 404);
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
