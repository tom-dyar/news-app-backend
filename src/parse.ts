export interface ParsedArticle {
	headline: string;
	source: string;
	published_at: string; // YYYY-MM-DD
	url: string;
	summary: string | null;
	relevance_score: number | null;
}

interface BlockLike {
	type: string;
	text?: string;
}

/**
 * With web search, Claude's answer is split across many content blocks (text interleaved with
 * server_tool_use / web_search_tool_result). Concatenate every text block before parsing.
 */
export function extractText(content: readonly BlockLike[]): string {
	return content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
}

/** Find the JSON array of article objects inside free-form text (handles prose and code fences). */
export function extractArticles(text: string): Record<string, unknown>[] {
	const end = text.lastIndexOf("]");
	if (end < 0) return [];
	// Candidate starts: a "[" followed (after whitespace) by "{" or "]" — skips bracketed prose like "[see below]".
	const starts = [...text.matchAll(/\[(?=\s*[{\]])/g)].map((m) => m.index!);
	for (const start of starts) {
		if (start > end) break;
		try {
			const parsed: unknown = JSON.parse(text.slice(start, end + 1));
			if (Array.isArray(parsed)) return parsed.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
		} catch {
			// try the next candidate start
		}
	}
	return [];
}

const str = (v: unknown, max = Infinity): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

// Everything here originates from web pages Claude read, so bound it before it reaches the database.
const MAX_HEADLINE = 300;
const MAX_SOURCE = 120;
const MAX_SUMMARY = 1200;
const MAX_URL = 2000;

export function normalizeArticle(raw: unknown, now: Date): ParsedArticle | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;

	const headline = str(r.headline, MAX_HEADLINE);
	const url = str(r.url);
	if (!headline || url.length > MAX_URL || !/^https?:\/\/\S+$/i.test(url)) return null;
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		return null;
	}

	const parsedDate = new Date(str(r.published_date ?? r.published_at));
	const published_at = (Number.isNaN(parsedDate.getTime()) ? now : parsedDate).toISOString().slice(0, 10);

	const score = typeof r.relevance_score === "number" && Number.isFinite(r.relevance_score) ? Math.min(10, Math.max(1, Math.round(r.relevance_score))) : null;

	return {
		headline,
		source: str(r.source, MAX_SOURCE) || parsedUrl.hostname.replace(/^www\./, ""),
		published_at,
		url,
		summary: str(r.summary, MAX_SUMMARY) || null,
		relevance_score: score,
	};
}
