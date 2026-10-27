import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler } from "../src/index";
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
	it("rejects every request without the correct password with 401, whatever the method", async () => {
		for (const method of ["POST", "GET", "PUT"]) {
			const res = await handler.fetch(req("/agent", { method }), e);
			expect(res.status).toBe(401);
			expect(res.headers.get("www-authenticate")).toContain("Bearer");
		}
		expect((await handler.fetch(req("/agent", { method: "POST", headers: { Authorization: "Bearer wrong" } }), e)).status).toBe(401);
		expect((await handler.fetch(req("/agent", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}x` } }), e)).status).toBe(401);
		expect(calls).toBe(0);
	});
	it("runs only with the password, and only for POST", async () => {
		expect((await handler.fetch(req("/agent", { headers: { Authorization: `Bearer ${TOKEN}` } }), e)).status).toBe(405);
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

describe("there is no public way to run the pipeline", () => {
	it.each(["GET", "POST"])("%s /refresh no longer exists", async (method) => {
		const res = await handler.fetch(req("/refresh", { method }), e);
		expect(res.status).toBe(404);
		expect(calls).toBe(0);
	});
	it("public endpoints stay public and never start a run", async () => {
		expect((await handler.fetch(req("/health"), e)).status).toBe(200);
		expect((await handler.fetch(req("/articles?limit=1"), e)).status).toBe(200);
		expect(calls).toBe(0);
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
