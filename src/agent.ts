import { insertArticles, trimTopic } from "./db";
import type { TopicResult } from "./anthropic";
import { MAX_ARTICLES_PER_TOPIC, TOPICS, type Topic } from "./topics";

export type FetchTopicArticles = (env: Env, topic: Topic) => Promise<TopicResult>;

export interface TopicSummary {
	topic: string;
	returned: number;
	inserted: number;
	skipped: number;
	invalid: number;
	removed: number;
	note?: string;
	error?: string;
}

export interface AgentSummary {
	inserted: number;
	skipped: number;
	totalReturned: number;
	topics: TopicSummary[];
}

/** Run the pipeline for every topic. Topics run in parallel and fail independently. */
export async function runAgent(env: Env, fetchTopic: FetchTopicArticles): Promise<AgentSummary> {
	const topics = await Promise.all(
		TOPICS.map(async (topic): Promise<TopicSummary> => {
			const summary: TopicSummary = { topic: topic.label, returned: 0, inserted: 0, skipped: 0, invalid: 0, removed: 0 };
			try {
				const { articles, returned, note } = await fetchTopic(env, topic);
				const { inserted, skipped } = await insertArticles(env.DB, topic.label, articles);
				const removed = await trimTopic(env.DB, topic.label, MAX_ARTICLES_PER_TOPIC);
				Object.assign(summary, { returned, inserted, skipped, invalid: returned - articles.length, removed, ...(note && { note }) });
			} catch (err) {
				summary.error = err instanceof Error ? err.message : String(err);
				console.error(`agent: topic "${topic.label}" failed:`, summary.error);
			}
			return summary;
		}),
	);
	return {
		inserted: topics.reduce((n, t) => n + t.inserted, 0),
		skipped: topics.reduce((n, t) => n + t.skipped, 0),
		totalReturned: topics.reduce((n, t) => n + t.returned, 0),
		topics,
	};
}
