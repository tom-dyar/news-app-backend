import type { ParsedArticle } from "./parse";

export type NewArticle = ParsedArticle;

export interface ArticleRow extends ParsedArticle {
	id: number;
	topic: string;
	fetched_at: string;
}

export interface ArticleFilters {
	topic?: string;
	from?: string;
	to?: string;
	source?: string;
	minScore?: number;
	limit: number;
}

/** Insert articles, skipping any whose URL is already stored (URL is UNIQUE across all topics). */
export async function insertArticles(db: D1Database, topic: string, articles: NewArticle[]): Promise<{ inserted: number; skipped: number }> {
	if (articles.length === 0) return { inserted: 0, skipped: 0 };
	const stmt = db.prepare(
		`INSERT OR IGNORE INTO articles (topic, headline, source, published_at, url, summary, relevance_score)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	const results = await db.batch(articles.map((a) => stmt.bind(topic, a.headline, a.source, a.published_at, a.url, a.summary, a.relevance_score)));
	const inserted = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
	return { inserted, skipped: articles.length - inserted };
}

/** Keep only the newest `cap` articles for a topic (by publication date); returns how many were removed. */
export async function trimTopic(db: D1Database, topic: string, cap: number): Promise<number> {
	const res = await db
		.prepare(
			`DELETE FROM articles WHERE topic = ?1 AND id NOT IN (
			   SELECT id FROM articles WHERE topic = ?1 ORDER BY published_at DESC, fetched_at DESC, id DESC LIMIT ?2
			 )`,
		)
		.bind(topic, cap)
		.run();
	return res.meta.changes ?? 0;
}

export async function queryArticles(db: D1Database, f: ArticleFilters): Promise<ArticleRow[]> {
	const where: string[] = [];
	const args: (string | number)[] = [];
	if (f.topic) {
		where.push("topic = ?");
		args.push(f.topic);
	}
	if (f.from) {
		where.push("published_at >= ?");
		args.push(f.from);
	}
	if (f.to) {
		where.push("published_at <= ?");
		args.push(f.to);
	}
	if (f.source) {
		where.push("source LIKE ? ESCAPE '\\' COLLATE NOCASE");
		args.push(`%${f.source.replace(/[\\%_]/g, "\\$&")}%`);
	}
	if (f.minScore !== undefined) {
		where.push("relevance_score >= ?");
		args.push(f.minScore);
	}
	args.push(f.limit);
	const sql = `SELECT id, topic, headline, source, published_at, url, summary, relevance_score, fetched_at
	             FROM articles ${where.length ? "WHERE " + where.join(" AND ") : ""}
	             ORDER BY published_at DESC, relevance_score DESC, id DESC LIMIT ?`;
	const { results } = await db.prepare(sql).bind(...args).all<ArticleRow>();
	return results;
}
