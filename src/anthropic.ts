import Anthropic from "@anthropic-ai/sdk";
import { extractArticles, extractText, normalizeArticle, type ParsedArticle } from "./parse";
import { ChatError, type ChatCall, type ChatEvent } from "./chat";
import type { Topic } from "./topics";

// Sonnet 5.5: supports web_search_20260209 and is well within this workspace's rate limits (Opus 5.5 is set to 0 RPM there).
const MODEL = "claude-sonnet-5-5";
const ARTICLES_PER_TOPIC = 5;
const MAX_CONTINUATIONS = 4;

export interface TopicResult {
	articles: ParsedArticle[];
	/** Number of article objects Claude returned (before validation). */
	returned: number;
	/** Set when nothing was parsed: the stop reason and start of Claude's reply, for debugging. */
	note?: string;
}

function buildPrompt(topic: Topic, today: string): string {
	return `Today is ${today}. Use web search to find the ${ARTICLES_PER_TOPIC} most recent and significant news articles from the past 7 days on this topic:

"${topic.label}"
Areas of interest: ${topic.focus}.

Prefer reputable news outlets, trade press, and primary sources (for legal and enforcement topics also check court-ruling coverage, agency press releases from DOJ/HHS/FTC/FDA/state attorneys general, and outlets like Reuters, STAT, Healthcare Dive, Fierce Healthcare, Law360, Bloomberg Law). Prefer news reports and press releases over law-firm explainer posts. Run several differently-worded searches if the first ones return only older material.
Each article must be a real, distinct article published in the past 7 days, with a working URL that you found via search; never invent or guess a URL or a date. If fewer than ${ARTICLES_PER_TOPIC} qualifying articles exist, return only those that do.

When you have finished searching, reply with ONLY a JSON array (no prose, no markdown fences; use [] if you found nothing) of up to ${ARTICLES_PER_TOPIC} objects with these keys:
- "headline": string
- "source": string, the publication name
- "published_date": string, YYYY-MM-DD
- "url": string, the article URL
- "summary": string, 2-3 sentences summarizing the article
- "relevance_score": integer 1-10, how significant and relevant this is to the topic`;
}

/** Ask Claude (with web search) for the top articles for one topic. */
export async function fetchTopicArticles(env: Pick<Env, "ANTHROPIC_API_KEY">, topic: Topic, now = new Date()): Promise<TopicResult> {
	const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
	const messages: Anthropic.MessageParam[] = [{ role: "user", content: buildPrompt(topic, now.toISOString().slice(0, 10)) }];

	let text = "";
	let stopReason: string | null = null;
	for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
		const response = await client.messages.create({
			model: MODEL,
			max_tokens: 16000,
			tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 12 }],
			messages,
		});
		if (response.stop_reason === "refusal") throw new Error(`Claude refused the request (${response.stop_details?.category ?? "unknown"})`);
		// Concatenate ALL text blocks — web search splits the answer across many blocks.
		text = extractText(response.content);
		stopReason = response.stop_reason;
		if (response.stop_reason !== "pause_turn") break;
		// Server-side tool loop hit its iteration limit: send the assistant turn back to resume it.
		messages.push({ role: "assistant", content: response.content });
	}

	const raw = extractArticles(text);
	const articles = raw.map((r) => normalizeArticle(r, now)).filter((a): a is ParsedArticle => a !== null);
	const note = articles.length === 0 ? `stop_reason=${stopReason}; reply: ${text.slice(0, 400) || "(no text)"}` : undefined;
	return { articles, returned: raw.length, note };
}

function toChatError(err: unknown): ChatError {
	console.error("chat: upstream error:", err instanceof Error ? err.message : err);
	const status = err instanceof Anthropic.APIError ? (err.status ?? 502) : 502;
	if (status === 429) return new ChatError(429, "The model is rate limited right now. Try again shortly or choose a different model.");
	return new ChatError(502, "The model request failed. Try again, or choose a different model.");
}

/**
 * Stream an answer from Claude. HTTP-level failures (rate limit, bad key, ...) throw a ChatError before this
 * resolves so the caller can return a real HTTP status; failures after streaming starts surface while iterating.
 */
export async function streamChat(env: Pick<Env, "ANTHROPIC_API_KEY">, call: ChatCall): Promise<AsyncIterable<ChatEvent>> {
	const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 });
	let stream;
	try {
		stream = await client.beta.messages.create({
			model: call.model.id,
			max_tokens: 4096,
			stream: true,
			system: call.system,
			messages: call.messages,
			// Answering from supplied context needs little deliberation; keep time-to-first-token low.
			output_config: { effort: "low" },
			// If a safety classifier declines, let the API re-run the request on its fallback model (not offered for Haiku).
			...(call.model.fallbacks && { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
		});
	} catch (err) {
		throw toChatError(err);
	}

	return (async function* () {
		let model: string = call.model.id;
		let stopReason: string | null = null;
		const usage = { input_tokens: 0, output_tokens: 0 };
		for await (const event of stream) {
			if (event.type === "message_start") {
				model = event.message.model;
				usage.input_tokens = event.message.usage.input_tokens;
			} else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
				yield { type: "delta", text: event.delta.text };
			} else if (event.type === "message_delta") {
				stopReason = event.delta.stop_reason;
				usage.output_tokens = event.usage.output_tokens;
			}
		}
		yield { type: "done", stopReason, usage, model };
	})();
}
