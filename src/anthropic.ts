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
 * Per answer cap on web searches, which bounds the extra cost of switching web search on.
 * The basic search tool is used for every model on purpose: the newer web_search_20260209 variant makes Claude write
 * code to call search, which hides the query inside a code block and streams its between-step narration as answer text.
 */
const MAX_WEB_SEARCHES = 3;
const WEB_SEARCH_TOOL = "web_search_20250305";
/** The server-side search loop can pause a long turn; each pause is resumed once more, up to this many times. */
const MAX_CHAT_CONTINUATIONS = 3;

/**
 * Stream an answer from Claude, optionally with web search. Failures before any text is produced surface as a
 * ChatError from the first `next()`, so the caller can return a real HTTP status.
 */
export async function streamChat(env: Pick<Env, "ANTHROPIC_API_KEY">, call: ChatCall): Promise<AsyncIterable<ChatEvent>> {
	const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 });
	const messages: Anthropic.Beta.BetaMessageParam[] = call.messages.map((m) => ({ role: m.role, content: m.content }));

	return (async function* (): AsyncGenerator<ChatEvent> {
		let model: string = call.model.id;
		let stopReason: string | null = null;
		const usage = { input_tokens: 0, output_tokens: 0, web_searches: 0 };
		try {
			for (let turn = 0; turn <= MAX_CHAT_CONTINUATIONS; turn++) {
				const stream = client.beta.messages.stream({
					model: call.model.id,
					max_tokens: 4096,
					system: call.system,
					messages,
					// Per model: Haiku stays at "low" so it is quick to start; the others use "medium" for advice and analysis.
					output_config: { effort: call.model.effort },
					...(call.webSearch && { tools: [{ type: WEB_SEARCH_TOOL, name: "web_search", max_uses: MAX_WEB_SEARCHES }] }),
					// If a safety classifier declines, let the API re-run the request on its fallback model (not offered for Haiku).
					...(call.model.fallbacks && { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
				});

				const queryJson = new Map<number, string>(); // search tool calls whose query is still streaming in
				for await (const event of stream) {
					if (event.type === "message_start") {
						model = event.message.model;
						usage.input_tokens += event.message.usage.input_tokens;
					} else if (event.type === "content_block_start") {
						const block = event.content_block;
						if (block.type === "server_tool_use" && block.name === "web_search") queryJson.set(event.index, "");
						else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
							yield { type: "web_sources", sources: block.content.map((r) => ({ title: r.title, url: r.url })) };
						}
					} else if (event.type === "content_block_delta") {
						if (event.delta.type === "text_delta") yield { type: "delta", text: event.delta.text };
						else if (event.delta.type === "input_json_delta" && queryJson.has(event.index)) queryJson.set(event.index, queryJson.get(event.index)! + event.delta.partial_json);
					} else if (event.type === "content_block_stop" && queryJson.has(event.index)) {
						try {
							const query = (JSON.parse(queryJson.get(event.index)!) as { query?: unknown }).query;
							if (typeof query === "string") yield { type: "search", query };
						} catch {
							// a malformed query isn't worth failing the answer over
						}
						queryJson.delete(event.index);
					} else if (event.type === "message_delta") {
						stopReason = event.delta.stop_reason;
						usage.output_tokens += event.usage.output_tokens;
						usage.web_searches += event.usage.server_tool_use?.web_search_requests ?? 0;
					}
				}

				const finalMessage = await stream.finalMessage();
				if (finalMessage.stop_reason !== "pause_turn") break;
				messages.push({ role: "assistant", content: finalMessage.content });
			}
		} catch (err) {
			throw toChatError(err);
		}
		yield { type: "done", stopReason, usage: call.webSearch ? usage : { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens }, model };
	})();
}
