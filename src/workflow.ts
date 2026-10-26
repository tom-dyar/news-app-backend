import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { formatSlackText, runTopic, summarize, type AgentSummary } from "./agent";
import { fetchTopicArticles } from "./anthropic";
import { TOPICS } from "./topics";

export interface RunParams {
	/** Who/what started the run, for logs (e.g. "trigger", "slack:U123"). */
	source: string;
	/** Slack response_url to post the result to when finished. */
	responseUrl?: string;
}

/**
 * Durable background run of the news pipeline. The HTTP request that starts it returns immediately,
 * because work after a response is cut off after 30s but a run takes a minute or more.
 */
export class NewsRunWorkflow extends WorkflowEntrypoint<Env, RunParams> {
	async run(event: WorkflowEvent<RunParams>, step: WorkflowStep): Promise<AgentSummary> {
		const topics = await Promise.all(TOPICS.map((topic) => step.do(`topic: ${topic.id}`, () => runTopic(this.env, topic, fetchTopicArticles))));
		const summary = summarize(topics);
		console.log(`workflow run (${event.payload.source}): inserted=${summary.inserted} skipped=${summary.skipped} returned=${summary.totalReturned}`);

		const { responseUrl } = event.payload;
		if (responseUrl) {
			await step.do("reply to slack", async () => {
				const res = await fetch(responseUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ response_type: "in_channel", text: formatSlackText(summary) }),
				});
				if (!res.ok) throw new Error(`Slack response_url returned ${res.status}`);
			});
		}
		return summary;
	}
}
