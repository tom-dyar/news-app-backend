import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler } from "../src/index";
import { publicSummary, summarize } from "../src/agent";
import type { NewArticle } from "../src/db";
import { TOPICS } from "../src/topics";

const TOKEN = "test-trigger-token";
const DASHBOARD = "https://news-app-frontend.pages.dev";
const e = { DB: env.DB, TRIGGER_TOKEN: TOKEN } as Env;
const req = (path: string, init?: RequestInit) => new Request(`https://news.test${path}`, init);

const fakeArticle = (topic: string, i: number): NewArticle => ({
	headline: `${topic} #${i}`, source: "Fake", published_at: "2026-10-25", url: `https://fake.test/${encodeURIComponent(topic)}/${i}`, summary: "x", relevance_score: 5,
});

let calls = 0;
const handler = createHandler({
	fetchTopicArticles: async (_e, topic) => {
		calls++;
		if (topic.id === TOPICS[0].id) throw new Error("429 rate_limit_error workspace Default request_id req_SECRET123");
		return { articles: [fakeArticle(topic.label, 1)], returned: 1, note: "reply: secret model text" };
	},
});

beforeEach(async () => {
	calls = 0;
	await env.DB.prepare("DELETE FROM agent_runs").run();
	await env.DB.prepare("DELETE FROM articles").run();
});

describe("/agent is token-protected", () => {
	it("rejects anonymous POST (401) and any GET (405) without running the pipeline", async () => {
		expect((await handler.fetch(req("/agent", { method: "POST" }), e)).status).toBe(401);
		expect((await handler.fetch(req("/agent", { method: "POST", headers: { Authorization: "Bearer wrong" } }), e)).status).toBe(401);
		expect((await handler.fetch(req("/agent"), e)).status).toBe(405);
		expect(calls).toBe(0);
	});
	it("runs with a valid token and returns full detail", async () => {
		const res = await handler.fetch(req("/agent", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } }), e);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.topics[0].error).toContain("req_SECRET123");
	});
	it("fails closed when no token is configured", async () => {
		expect((await handler.fetch(req("/agent", { method: "POST", headers: { Authorization: "Bearer x" } }), { DB: env.DB } as Env)).status).toBe(503);
	});
});

describe("POST /refresh (public, rate limited)", () => {
	it("only accepts POST", async () => {
		expect((await handler.fetch(req("/refresh"), e)).status).toBe(405);
	});

	it("runs once, then refuses with 429 + Retry-After during the cooldown", async () => {
		const first = await handler.fetch(req("/refresh", { method: "POST" }), e);
		expect(first.status).toBe(200);
		const callsAfterFirst = calls;
		const second = await handler.fetch(req("/refresh", { method: "POST" }), e);
		expect(second.status).toBe(429);
		expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
		expect(((await second.json()) as any).retryAfterSeconds).toBeGreaterThan(0);
		expect(calls).toBe(callsAfterFirst);
	});

	it("never leaks upstream error text, request ids or model output", async () => {
		const res = await handler.fetch(req("/refresh", { method: "POST" }), e);
		const text = await res.text();
		expect(text).not.toContain("req_SECRET123");
		expect(text).not.toContain("rate_limit_error");
		expect(text).not.toContain("secret model text");
		const body = JSON.parse(text);
		expect(body.topics[0]).toMatchObject({ failed: true });
		expect(body.inserted).toBe(TOPICS.length - 1);
	});

	it("a recent scheduled-style claim also blocks public refresh", async () => {
		const now = Math.floor(Date.now() / 1000);
		await env.DB.prepare("INSERT INTO agent_runs (started_at, source) VALUES (?, 'cron')").bind(now - 60).run();
		expect((await handler.fetch(req("/refresh", { method: "POST" }), e)).status).toBe(429);
		expect(calls).toBe(0);
	});
});

describe("publicSummary", () => {
	it("keeps counts, drops error/note text", () => {
		const s = summarize([{ topic: "t", returned: 2, inserted: 1, skipped: 1, invalid: 0, removed: 3, note: "n", error: "boom" }]);
		const p = publicSummary(s) as any;
		expect(JSON.stringify(p)).not.toContain("boom");
		expect(JSON.stringify(p)).not.toContain("removed");
		expect(p.topics[0]).toEqual({ topic: "t", returned: 2, inserted: 1, skipped: 1, failed: true });
	});
});

describe("CORS allowlist", () => {
	it.each([DASHBOARD, "https://abc123.news-app-frontend.pages.dev", "http://localhost:8788"])("echoes allowed origin %s", async (origin) => {
		const res = await handler.fetch(req("/health", { headers: { Origin: origin } }), e);
		expect(res.headers.get("access-control-allow-origin")).toBe(origin);
		expect(res.headers.get("vary")).toContain("Origin");
	});
	it.each(["https://evil.example", "https://news-app-frontend.pages.dev.evil.example", "http://localhost.evil.example", "null"])("does not echo %s", async (origin) => {
		const res = await handler.fetch(req("/health", { headers: { Origin: origin } }), e);
		expect(res.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
	});
	it("never uses a wildcard, including on errors and preflight", async () => {
		for (const r of [req("/nope"), req("/articles?limit=abc"), req("/agent", { method: "OPTIONS" })]) {
			expect((await handler.fetch(r, e)).headers.get("access-control-allow-origin")).not.toBe("*");
		}
	});
});

describe("security headers", () => {
	it("are set on API responses, and mutating endpoints are not cacheable", async () => {
		const res = await handler.fetch(req("/health"), e);
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
		expect(res.headers.get("referrer-policy")).toBe("no-referrer");
		const post = await handler.fetch(req("/agent", { method: "POST" }), e);
		expect(post.headers.get("cache-control")).toBe("no-store");
	});
});

describe("input limits", () => {
	it("rejects an oversized source filter", async () => {
		expect((await handler.fetch(req(`/articles?source=${"a".repeat(101)}`), e)).status).toBe(400);
	});
});
