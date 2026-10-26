import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, type Deps } from "../src/index";

const TOKEN = "test-trigger-token";
const SLACK_SECRET = "slack-secret";

function setup(extra: Partial<Env> = {}) {
	const started: unknown[] = [];
	const deps: Deps = {
		fetchTopicArticles: async () => ({ articles: [], returned: 0 }),
		startRun: async (_env, params) => (started.push(params), "run-123"),
		getRun: async (_env, id) => (id === "run-123" ? { status: "running" } : null),
	};
	const e = { DB: env.DB, TRIGGER_TOKEN: TOKEN, ...extra } as Env;
	return { started, e, handler: createHandler(deps) };
}
beforeEach(async () => {
	await env.DB.prepare("DELETE FROM agent_runs").run();
});

const req = (path: string, init?: RequestInit) => new Request(`https://news.test${path}`, init);
const auth = (t = TOKEN) => ({ Authorization: `Bearer ${t}` });

describe("POST /trigger", () => {
	it("rejects missing and wrong tokens with 401 and does not start a run", async () => {
		const { handler, e, started } = setup();
		const none = await handler.fetch(req("/trigger", { method: "POST" }), e);
		expect(none.status).toBe(401);
		expect(none.headers.get("www-authenticate")).toContain("Bearer");
		expect(none.headers.get("access-control-allow-origin")).toBe("https://news-app-frontend.pages.dev");
		expect((await handler.fetch(req("/trigger", { method: "POST", headers: auth("wrong") }), e)).status).toBe(401);
		expect(started).toHaveLength(0);
	});

	it("fails closed (503) when no token is configured", async () => {
		const { handler, e, started } = setup({ TRIGGER_TOKEN: undefined as never });
		expect((await handler.fetch(req("/trigger", { method: "POST", headers: auth("anything") }), e)).status).toBe(503);
		expect(started).toHaveLength(0);
	});

	it("starts a run with a valid token and returns 202 with the run id and status URL", async () => {
		const { handler, e, started } = setup();
		const res = await handler.fetch(req("/trigger", { method: "POST", headers: auth() }), e);
		expect(res.status).toBe(202);
		const body = (await res.json()) as any;
		expect(body).toMatchObject({ status: "queued", runId: "run-123", statusUrl: "https://news.test/trigger/run-123" });
		expect(started).toEqual([{ source: "trigger" }]);
	});

	it("refuses a second run within 5 minutes (runaway-automation guard) with 429 + Retry-After", async () => {
		const { handler, e, started } = setup();
		expect((await handler.fetch(req("/trigger", { method: "POST", headers: auth() }), e)).status).toBe(202);
		const again = await handler.fetch(req("/trigger", { method: "POST", headers: auth() }), e);
		expect(again.status).toBe(429);
		expect(Number(again.headers.get("retry-after"))).toBeGreaterThan(0);
		expect(started).toHaveLength(1);
	});

	it("only allows POST on /trigger", async () => {
		const { handler, e } = setup();
		expect((await handler.fetch(req("/trigger", { headers: auth() }), e)).status).toBe(405);
	});
});

describe("GET /trigger/:id", () => {
	it("requires the token", async () => {
		const { handler, e } = setup();
		expect((await handler.fetch(req("/trigger/run-123"), e)).status).toBe(401);
	});
	it("returns run status, or 404 for unknown runs", async () => {
		const { handler, e } = setup();
		const ok = await handler.fetch(req("/trigger/run-123", { headers: auth() }), e);
		expect(ok.status).toBe(200);
		expect(await ok.json()).toMatchObject({ runId: "run-123", status: "running" });
		expect((await handler.fetch(req("/trigger/nope", { headers: auth() }), e)).status).toBe(404);
	});
});

async function slackReq(body: string, secret = SLACK_SECRET, ts = String(Math.floor(Date.now() / 1000))) {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`));
	const sig = "v0=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return req("/slack/command", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": sig }, body });
}
const slackBody = (over: Record<string, string> = {}) =>
	new URLSearchParams({ command: "/news", user_id: "U123", response_url: "https://hooks.slack.com/commands/T/B/xyz", ...over }).toString();

describe("POST /slack/command", () => {
	it("is disabled (503) until a signing secret is configured", async () => {
		const { handler, e } = setup();
		expect((await handler.fetch(await slackReq(slackBody()), e)).status).toBe(503);
	});

	it("rejects a bad signature with 401 and starts nothing", async () => {
		const { handler, e, started } = setup({ SLACK_SIGNING_SECRET: SLACK_SECRET });
		expect((await handler.fetch(await slackReq(slackBody(), "wrong-secret"), e)).status).toBe(401);
		expect(started).toHaveLength(0);
	});

	it("acknowledges immediately and starts a run that will reply to the response_url", async () => {
		const { handler, e, started } = setup({ SLACK_SIGNING_SECRET: SLACK_SECRET });
		const res = await handler.fetch(await slackReq(slackBody()), e);
		expect(res.status).toBe(200);
		expect(((await res.json()) as any).text).toMatch(/running/i);
		expect(started).toEqual([{ source: "slack:U123", responseUrl: "https://hooks.slack.com/commands/T/B/xyz" }]);
	});

	it("refuses users outside SLACK_ALLOWED_USERS", async () => {
		const { handler, e, started } = setup({ SLACK_SIGNING_SECRET: SLACK_SECRET, SLACK_ALLOWED_USERS: "U999, U888" });
		const res = await handler.fetch(await slackReq(slackBody()), e);
		expect(res.status).toBe(200);
		expect(((await res.json()) as any).text).toMatch(/not authorized/i);
		expect(started).toHaveLength(0);
		const allowed = await handler.fetch(await slackReq(slackBody({ user_id: "U888" })), e);
		expect(((await allowed.json()) as any).text).toMatch(/running/i);
		expect(started).toHaveLength(1);
	});

	it("ignores a response_url that is not on hooks.slack.com", async () => {
		const { handler, e, started } = setup({ SLACK_SIGNING_SECRET: SLACK_SECRET });
		await handler.fetch(await slackReq(slackBody({ response_url: "https://evil.test/steal" })), e);
		expect(started).toEqual([{ source: "slack:U123" }]);
	});
});
