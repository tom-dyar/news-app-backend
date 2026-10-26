import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertArticles, queryArticles, trimTopic, type NewArticle } from "../src/db";

const TOPIC = "cybersecurity in healthcare";

function art(n: number, over: Partial<NewArticle> = {}): NewArticle {
	return {
		headline: `Headline ${n}`,
		source: "Src",
		published_at: `2026-10-${String(n).padStart(2, "0")}`,
		url: `https://example.com/${n}`,
		summary: "s",
		relevance_score: 5,
		...over,
	};
}

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM articles").run();
});

describe("insertArticles", () => {
	it("inserts new articles and skips URLs already stored", async () => {
		expect(await insertArticles(env.DB, TOPIC, [art(1), art(2)])).toEqual({ inserted: 2, skipped: 0 });
		expect(await insertArticles(env.DB, TOPIC, [art(2), art(3)])).toEqual({ inserted: 1, skipped: 1 });
	});

	it("skips duplicates within the same batch and across topics", async () => {
		expect(await insertArticles(env.DB, TOPIC, [art(1), art(1)])).toEqual({ inserted: 1, skipped: 1 });
		expect(await insertArticles(env.DB, "other topic", [art(1)])).toEqual({ inserted: 0, skipped: 1 });
	});

	it("handles an empty batch", async () => {
		expect(await insertArticles(env.DB, TOPIC, [])).toEqual({ inserted: 0, skipped: 0 });
	});
});

describe("trimTopic", () => {
	it("removes the oldest articles beyond the cap, only for that topic", async () => {
		await insertArticles(env.DB, TOPIC, Array.from({ length: 25 }, (_, i) => art(i + 1)));
		await insertArticles(env.DB, "other", [art(26, { url: "https://other/1", published_at: "2026-01-01" })]);
		expect(await trimTopic(env.DB, TOPIC, 20)).toBe(5);
		const kept = await queryArticles(env.DB, { topic: TOPIC, limit: 100 });
		expect(kept).toHaveLength(20);
		expect(kept.map((a) => a.published_at).sort()[0]).toBe("2026-10-06");
		expect(await queryArticles(env.DB, { topic: "other", limit: 100 })).toHaveLength(1);
	});

	it("does nothing when under the cap", async () => {
		await insertArticles(env.DB, TOPIC, [art(1)]);
		expect(await trimTopic(env.DB, TOPIC, 20)).toBe(0);
	});
});

describe("queryArticles", () => {
	beforeEach(async () => {
		await insertArticles(env.DB, TOPIC, [
			art(1, { source: "HIPAA Journal", relevance_score: 9 }),
			art(2, { source: "STAT News", relevance_score: 4 }),
			art(3, { source: "HIPAA Journal", relevance_score: 6 }),
		]);
		await insertArticles(env.DB, "AI advances in healthcare", [art(4, { relevance_score: 7 })]);
	});

	it("returns newest first by default", async () => {
		const rows = await queryArticles(env.DB, { limit: 50 });
		expect(rows.map((r) => r.published_at)).toEqual(["2026-10-04", "2026-10-03", "2026-10-02", "2026-10-01"]);
	});

	it("filters by topic, source, min score, date range, and limit", async () => {
		expect(await queryArticles(env.DB, { topic: TOPIC, limit: 50 })).toHaveLength(3);
		expect(await queryArticles(env.DB, { source: "hipaa", limit: 50 })).toHaveLength(2);
		expect(await queryArticles(env.DB, { minScore: 7, limit: 50 })).toHaveLength(2);
		expect(await queryArticles(env.DB, { from: "2026-10-02", to: "2026-10-03", limit: 50 })).toHaveLength(2);
		expect(await queryArticles(env.DB, { limit: 1 })).toHaveLength(1);
	});

	it("treats LIKE wildcards in source literally", async () => {
		expect(await queryArticles(env.DB, { source: "%", limit: 50 })).toHaveLength(0);
	});
});
