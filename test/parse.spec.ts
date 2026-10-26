import { describe, expect, it } from "vitest";
import { extractArticles, extractText, normalizeArticle } from "../src/parse";

const NOW = new Date("2026-10-26T12:00:00Z");

describe("extractText", () => {
	it("concatenates every text block and ignores other block types", () => {
		const content = [
			{ type: "text", text: "Here you go: [" },
			{ type: "server_tool_use", id: "x", name: "web_search", input: {} },
			{ type: "web_search_tool_result", tool_use_id: "x", content: [] },
			{ type: "text", text: '{"a":1}' },
			{ type: "text", text: "]" },
		];
		expect(extractText(content as never)).toBe('Here you go: [{"a":1}]');
	});
});

describe("extractArticles", () => {
	it("parses a bare JSON array", () => {
		expect(extractArticles('[{"headline":"A"},{"headline":"B"}]')).toHaveLength(2);
	});

	it("parses an array split across several text fragments with prose around it", () => {
		const text = 'Searching...\nI found these:\n```json\n[\n{"headline":"A"},\n{"headline":"B"}\n]\n```\nHope that helps.';
		expect(extractArticles(text).map((a) => a.headline)).toEqual(["A", "B"]);
	});

	it("skips bracketed prose before the real array", () => {
		const text = 'Results [see below] follow: [{"headline":"A"}]';
		expect(extractArticles(text)).toEqual([{ headline: "A" }]);
	});

	it("returns [] when there is no JSON array", () => {
		expect(extractArticles("no results")).toEqual([]);
		expect(extractArticles("[not json]")).toEqual([]);
		expect(extractArticles("")).toEqual([]);
	});
});

describe("normalizeArticle", () => {
	const good = {
		headline: " Hospital hit by ransomware ",
		source: "HIPAA Journal",
		published_date: "2026-10-24",
		url: "https://example.com/a",
		summary: "Two sentences. Here.",
		relevance_score: 8,
	};

	it("accepts a valid article and trims strings", () => {
		expect(normalizeArticle(good, NOW)).toEqual({
			headline: "Hospital hit by ransomware",
			source: "HIPAA Journal",
			published_at: "2026-10-24",
			url: "https://example.com/a",
			summary: "Two sentences. Here.",
			relevance_score: 8,
		});
	});

	it("rejects missing headline or non-http(s) url", () => {
		expect(normalizeArticle({ ...good, headline: "" }, NOW)).toBeNull();
		expect(normalizeArticle({ ...good, url: "javascript:alert(1)" }, NOW)).toBeNull();
		expect(normalizeArticle({ ...good, url: "nope" }, NOW)).toBeNull();
	});

	it("rounds and clamps relevance score into 1-10, nulling junk", () => {
		expect(normalizeArticle({ ...good, relevance_score: 7.6 }, NOW)?.relevance_score).toBe(8);
		expect(normalizeArticle({ ...good, relevance_score: 42 }, NOW)?.relevance_score).toBe(10);
		expect(normalizeArticle({ ...good, relevance_score: 0 }, NOW)?.relevance_score).toBe(1);
		expect(normalizeArticle({ ...good, relevance_score: "high" }, NOW)?.relevance_score).toBeNull();
	});

	it("normalizes dates and falls back to today when unparseable", () => {
		expect(normalizeArticle({ ...good, published_date: "2026-10-24T09:30:00Z" }, NOW)?.published_at).toBe("2026-10-24");
		expect(normalizeArticle({ ...good, published_date: "unknown" }, NOW)?.published_at).toBe("2026-10-26");
	});

	it("rejects non-objects", () => {
		expect(normalizeArticle(null, NOW)).toBeNull();
		expect(normalizeArticle("x", NOW)).toBeNull();
	});
});
