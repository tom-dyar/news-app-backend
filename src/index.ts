import { runAgent, type FetchTopicArticles } from "./agent";
import { fetchTopicArticles } from "./anthropic";
import { queryArticles } from "./db";
import { isSevenAmEastern } from "./schedule";
import { resolveTopic } from "./topics";

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
	"Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" } });
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

export interface Deps {
	fetchTopicArticles: FetchTopicArticles;
}

export function createHandler(deps: Deps) {
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
					default:
						return json({ error: "not found", endpoints: ["/health", "/agent", "/articles"] }, 404);
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
