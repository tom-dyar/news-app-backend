import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ChatError, type ChatEvent } from "../src/chat";
import { insertArticles, type NewArticle } from "../src/db";
import { createHandler, type Deps } from "../src/index";

const TOKEN = "test-trigger-token";
const e = { DB: env.DB, TRIGGER_TOKEN: TOKEN } as Env;
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const post = (body: unknown, headers: Record<string, string> = auth) =>
	new Request("https://news.test/chat", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

const article = (n: number, over: Partial<NewArticle> = {}): NewArticle => ({
	headline: `Headline ${n}`, source: "Src", published_at: "2026-10-26", url: `https://x.test/${n}`, summary: `Summary ${n}`, relevance_score: 5, ...over,
});

interface Captured { calls: Array<{ model: string; fallbacks: boolean; system: string; messages: any[] }> }
function make(events: ChatEvent[] | (() => AsyncGenerator<ChatEvent>), cap: Captured = { calls: [] }, failWith?: ChatError) {
	const deps: Deps = {
		fetchTopicArticles: async () => ({ articles: [], returned: 0 }),
		streamChat: async (_env, call) => {
			cap.calls.push({ model: call.model.id, fallbacks: call.model.fallbacks, system: call.system, messages: call.messages });
			if (failWith) throw failWith;
			return typeof events === "function" ? events() : (async function* () { yield* events; })();
		},
	};
	return { handler: createHandler(deps), cap };
}
const DONE: ChatEvent = { type: "done", stopReason: "end_turn", usage: { input_tokens: 100, output_tokens: 20 }, model: "claude-sonnet-5-5" };

function parseSse(text: string) {
	return text.trim().split("\n\n").filter(Boolean).map((block) => {
		const lines = block.split("\n");
		return { event: lines[0].replace("event: ", ""), data: JSON.parse(lines[1].replace("data: ", "")) };
	});
}

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM articles").run();
	await insertArticles(env.DB, "cybersecurity in healthcare", [
		article(1, { headline: "Ransomware hits Kansas hospital", summary: "Systems offline for days.", relevance_score: 9 }),
		article(2, { headline: "Vendor breach exposes 238K members", relevance_score: 6 }),
	]);
	await insertArticles(env.DB, "AI advances in healthcare", [article(3, { headline: "FDA clears AI imaging tool", relevance_score: 8 })]);
});

describe("POST /chat access control", () => {
	it("rejects requests without the password (401) and never calls Claude", async () => {
		const { handler, cap } = make([DONE]);
		for (const headers of [{ "Content-Type": "application/json" }, { ...auth, Authorization: "Bearer wrong" }]) {
			const res = await handler.fetch(post({ question: "hi" }, headers), e);
			expect(res.status).toBe(401);
			expect(res.headers.get("www-authenticate")).toContain("Bearer");
		}
		expect(cap.calls).toHaveLength(0);
	});
	it("returns 401 before 405 for anonymous GET, 405 for authenticated GET", async () => {
		const { handler } = make([DONE]);
		expect((await handler.fetch(new Request("https://news.test/chat"), e)).status).toBe(401);
		expect((await handler.fetch(new Request("https://news.test/chat", { headers: auth }), e)).status).toBe(405);
	});
	it("fails closed (503) if no password is configured", async () => {
		const { handler } = make([DONE]);
		expect((await handler.fetch(post({ question: "hi" }), { DB: env.DB } as Env)).status).toBe(503);
	});
});

describe("POST /chat validation", () => {
	it.each([
		["not json", "{nope"],
		["no question", {}],
		["bad model", { question: "q", model: "gpt-4" }],
		["bad topic", { question: "q", topic: "zzz" }],
	])("400 for %s", async (_name, body) => {
		const { handler, cap } = make([DONE]);
		const res = await handler.fetch(post(body), e);
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).error).toBeTruthy();
		expect(cap.calls).toHaveLength(0);
	});
	it("413 for an oversized body", async () => {
		const { handler } = make([DONE]);
		const res = await handler.fetch(post(JSON.stringify({ question: "q", pad: "x".repeat(70_000) })), e);
		expect(res.status).toBe(413);
	});
});

describe("POST /chat streaming (default)", () => {
	it("streams meta (sources) then deltas then done as Server-Sent Events", async () => {
		const { handler } = make([{ type: "delta", text: "The ransomware " }, { type: "delta", text: "attack [1]." }, DONE]);
		const res = await handler.fetch(post({ question: "Tell me about the ransomware attack" }), e);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("access-control-allow-origin")).toBe("https://news-app-frontend.pages.dev");
		const events = parseSse(await res.text());
		expect(events.map((x) => x.event)).toEqual(["meta", "delta", "delta", "done"]);
		expect(events[0].data.model).toBe("claude-sonnet-5-5");
		expect(events[0].data.sources[0]).toMatchObject({ n: 1, headline: "Ransomware hits Kansas hospital", url: "https://x.test/1", source: "Src", topic: "cybersecurity in healthcare" });
		expect(events[1].data.text + events[2].data.text).toBe("The ransomware attack [1].");
		expect(events[3].data).toMatchObject({ stopReason: "end_turn", usage: { output_tokens: 20 } });
	});

	it("retrieves the relevant articles, numbered in the prompt, and passes history through", async () => {
		const { handler, cap } = make([DONE]);
		await handler.fetch(post({ question: "ransomware?", max_articles: 1, history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] }), e);
		const call = cap.calls[0];
		expect(call.messages.slice(0, 2)).toEqual([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
		const last = call.messages.at(-1).content as string;
		expect(last).toContain("Ransomware hits Kansas hospital");
		expect(last).not.toContain("FDA clears AI imaging tool");
		expect(call.system).toMatch(/articles/i);
	});

	it("flags loose retrieval when no stored article matches the question's keywords", async () => {
		const { handler, cap } = make([DONE]);
		await handler.fetch(post({ question: "what should we do about vulncopalypse coming?" }), e);
		expect(cap.calls[0].messages.at(-1).content as string).toMatch(/none of these articles/i);
		await handler.fetch(post({ question: "tell me about the ransomware attack" }), e);
		expect(cap.calls[1].messages.at(-1).content as string).not.toMatch(/none of these articles/i);
	});

	it("scopes retrieval to a topic when asked", async () => {
		const { handler, cap } = make([DONE]);
		await handler.fetch(post({ question: "what happened?", topic: "healthcare-ai" }), e);
		const last = cap.calls[0].messages.at(-1).content as string;
		expect(last).toContain("FDA clears AI imaging tool");
		expect(last).not.toContain("Ransomware");
	});

	it("uses the preferred model and reports it", async () => {
		const { handler, cap } = make([DONE]);
		const res = await handler.fetch(post({ question: "q", model: "haiku" }), e);
		expect(cap.calls[0]).toMatchObject({ model: "claude-haiku-5-5", fallbacks: false });
		expect(parseSse(await res.text())[0].data.model).toBe("claude-haiku-5-5");
	});

	it("reports a mid-stream failure as an error event", async () => {
		const { handler } = make(async function* () {
			yield { type: "delta", text: "Partial " } as ChatEvent;
			throw new Error("boom: secret-detail");
		});
		const events = parseSse(await (await handler.fetch(post({ question: "q" }), e)).text());
		expect(events.map((x) => x.event)).toEqual(["meta", "delta", "error"]);
		expect(JSON.stringify(events.at(-1)!.data)).not.toContain("secret-detail");
	});

	it("answers without calling Claude when there are no articles yet", async () => {
		await env.DB.prepare("DELETE FROM articles").run();
		const { handler, cap } = make([DONE]);
		const events = parseSse(await (await handler.fetch(post({ question: "anything" }), e)).text());
		expect(cap.calls).toHaveLength(0);
		expect(events.map((x) => x.event)).toEqual(["meta", "delta", "done"]);
		expect(events[1].data.text).toMatch(/no articles/i);
		expect(events[0].data.sources).toEqual([]);
	});
});

describe("POST /chat early upstream errors become real HTTP errors", () => {
	it.each([
		[new ChatError(429, "rate limited"), 429],
		[new ChatError(400, "bad"), 502],
		[new ChatError(500, "overloaded"), 502],
	])("%s", async (err, status) => {
		const { handler } = make([DONE], { calls: [] }, err);
		const res = await handler.fetch(post({ question: "q" }), e);
		expect(res.status).toBe(status);
		expect(JSON.stringify(await res.json())).not.toMatch(/req_|api[-_]?key/i);
	});
});

describe("POST /chat with stream:false", () => {
	it("returns one JSON document with the answer, sources, model and usage", async () => {
		const { handler } = make([{ type: "delta", text: "Hello " }, { type: "delta", text: "world [1]" }, DONE]);
		const res = await handler.fetch(post({ question: "ransomware", stream: false }), e);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as any;
		expect(body).toMatchObject({ answer: "Hello world [1]", model: "claude-sonnet-5-5", stopReason: "end_turn", usage: { input_tokens: 100 } });
		expect(body.sources.length).toBeGreaterThan(0);
	});
	it("maps a refusal to a friendly error", async () => {
		const { handler } = make([{ type: "done", stopReason: "refusal", usage: { input_tokens: 1, output_tokens: 0 }, model: "x" }]);
		const res = await handler.fetch(post({ question: "q", stream: false }), e);
		expect(((await res.json()) as any).stopReason).toBe("refusal");
	});
});

describe("GET /chat/models", () => {
	it("lists selectable models publicly, with the default flagged", async () => {
		const { handler } = make([DONE]);
		const res = await handler.fetch(new Request("https://news.test/chat/models"), e);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.default).toBe("sonnet");
		expect(body.models.map((m: any) => m.alias)).toEqual(["haiku", "sonnet", "opus"]);
		expect(body.models[0]).toHaveProperty("label");
	});
});
