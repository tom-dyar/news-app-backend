import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler } from "../src/index";
import type { NewArticle } from "../src/db";
import { TOPICS } from "../src/topics";

const req = (path: string, init?: RequestInit) => new Request(`https://news.test${path}`, init);

function fakeArticles(topicLabel: string, n: number): NewArticle[] {
	return Array.from({ length: n }, (_, i) => ({
		headline: `${topicLabel} #${i}`,
		source: "Fake",
		published_at: "2026-10-25",
		url: `https://fake.test/${encodeURIComponent(topicLabel)}/${i}`,
		summary: "x",
		relevance_score: 5,
	}));
}

const handler = createHandler({
	// every topic returns 5 valid articles + 1 invalid → returned 6
	fetchTopicArticles: async (_env, topic) => ({ articles: fakeArticles(topic.label, 5), returned: 6 }),
});

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM articles").run();
});

describe("CORS", () => {
	it("answers preflight", async () => {
		const res = await handler.fetch(req("/agent", { method: "OPTIONS" }), env);
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		expect(res.headers.get("access-control-allow-methods")).toContain("GET");
	});
	it("is present on 404 and error responses", async () => {
		const nf = await handler.fetch(req("/nope"), env);
		expect(nf.status).toBe(404);
		expect(nf.headers.get("access-control-allow-origin")).toBe("*");
		const bad = await handler.fetch(req("/articles?min_score=abc"), env);
		expect(bad.status).toBe(400);
		expect(bad.headers.get("access-control-allow-origin")).toBe("*");
	});
});

describe("/health", () => {
	it("returns status ok and a timestamp", async () => {
		const res = await handler.fetch(req("/health"), env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; timestamp: string };
		expect(body.status).toBe("ok");
		expect(new Date(body.timestamp).toString()).not.toBe("Invalid Date");
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});
});

describe("/agent", () => {
	it("inserts, then skips duplicates on a second run", async () => {
		const first = (await (await handler.fetch(req("/agent", { method: "POST" }), env)).json()) as any;
		expect(first.inserted).toBe(15);
		expect(first.skipped).toBe(0);
		expect(first.totalReturned).toBe(18);
		expect(first.topics).toHaveLength(TOPICS.length);

		const second = (await (await handler.fetch(req("/agent"), env)).json()) as any;
		expect(second.inserted).toBe(0);
		expect(second.skipped).toBe(15);
	});

	it("isolates a failing topic and reports its error", async () => {
		const h = createHandler({
			fetchTopicArticles: async (_e, topic) => {
				if (topic.id === TOPICS[0].id) throw new Error("boom");
				return { articles: fakeArticles(topic.label, 1), returned: 1 };
			},
		});
		const body = (await (await h.fetch(req("/agent"), env)).json()) as any;
		expect(body.inserted).toBe(TOPICS.length - 1);
		expect(body.topics[0].error).toContain("boom");
	});

	it("enforces the 20-per-topic cap", async () => {
		const h = createHandler({
			fetchTopicArticles: async (_e, topic) => ({ articles: fakeArticles(topic.label, 25), returned: 25 }),
		});
		const body = (await (await h.fetch(req("/agent"), env)).json()) as any;
		expect(body.topics[0].removed).toBe(5);
		const list = (await (await h.fetch(req(`/articles?topic=${encodeURIComponent(TOPICS[0].label)}&limit=200`), env)).json()) as any;
		expect(list.count).toBe(20);
	});
});

describe("/articles", () => {
	beforeEach(async () => {
		await handler.fetch(req("/agent"), env);
	});

	it("returns articles and a count", async () => {
		const body = (await (await handler.fetch(req("/articles"), env)).json()) as any;
		expect(body.count).toBe(15);
		expect(body.articles).toHaveLength(15);
		expect(body.articles[0]).toHaveProperty("headline");
	});

	it("filters by topic id, limit, source, and min score", async () => {
		const byTopic = (await (await handler.fetch(req(`/articles?topic=${TOPICS[1].id}`), env)).json()) as any;
		expect(byTopic.count).toBe(5);
		const lim = (await (await handler.fetch(req("/articles?limit=3"), env)).json()) as any;
		expect(lim.count).toBe(3);
		const none = (await (await handler.fetch(req("/articles?min_score=9"), env)).json()) as any;
		expect(none.count).toBe(0);
		const src = (await (await handler.fetch(req("/articles?source=fake"), env)).json()) as any;
		expect(src.count).toBe(15);
	});

	it("validates parameters", async () => {
		for (const q of ["limit=0", "limit=abc", "min_score=11", "from=yesterday", "to=2026-13-45"]) {
			expect((await handler.fetch(req(`/articles?${q}`), env)).status).toBe(400);
		}
	});
});
