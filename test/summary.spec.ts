import { describe, expect, it } from "vitest";
import { formatSlackText, summarize, type TopicSummary } from "../src/agent";

const t = (over: Partial<TopicSummary>): TopicSummary => ({ topic: "x", returned: 5, inserted: 3, skipped: 2, invalid: 0, removed: 0, ...over });

describe("summarize", () => {
	it("totals across topics", () => {
		const s = summarize([t({}), t({ returned: 1, inserted: 1, skipped: 0 })]);
		expect(s).toMatchObject({ inserted: 4, skipped: 2, totalReturned: 6 });
		expect(s.topics).toHaveLength(2);
	});
});

describe("formatSlackText", () => {
	it("summarizes counts and lists per-topic results", () => {
		const text = formatSlackText(summarize([t({ topic: "AI" }), t({ topic: "Law", returned: 0, inserted: 0, skipped: 0 })]));
		expect(text).toContain("3 new articles added");
		expect(text).toContain("2 already known");
		expect(text).toContain("AI: 3 new");
		expect(text).toContain("Law: 0 new");
	});
	it("uses singular wording and flags failed topics", () => {
		const text = formatSlackText(summarize([t({ topic: "AI", inserted: 1, skipped: 1 }), t({ topic: "Law", inserted: 0, skipped: 0, error: "429 rate limit" })]));
		expect(text).toContain("1 new article added");
		expect(text).toContain("Law: failed");
		expect(text).toContain("429 rate limit");
	});
});
