<!-- markdownlint-disable MD013 MD010 -->

# Chat API

Ask questions about the collected news. The Worker picks the most relevant stored
articles, gives them to Claude as context, and returns the answer, either streamed
as it is written or as one JSON document.

Base URL: `https://news-app-backend.tom-dyar.workers.dev`

## Endpoints

| Endpoint           | Auth                    | Purpose                                      |
| ------------------ | ----------------------- | -------------------------------------------- |
| `POST /chat`       | `Authorization: Bearer` | Ask a question (streaming by default).       |
| `GET /chat/models` | none                    | Models a client may choose, and the default. |

`/chat` spends Anthropic credits, so it needs the same password as `/agent`.
Without it you get `401`.

## Request

```json
{
	"question": "What happened at the University of New Mexico hospitals?",
	"model": "sonnet",
	"stream": true,
	"topic": "healthcare-cybersecurity",
	"max_articles": 12,
	"history": [
		{ "role": "user", "content": "What are the top ransomware stories?" },
		{ "role": "assistant", "content": "The biggest is the UNM cyberattack…" }
	]
}
```

| Field          | Required | Notes                                                                                                        |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `question`     | yes      | Up to 2000 characters.                                                                                       |
| `model`        | no       | `haiku`, `sonnet` (default) or `opus`. Exact model IDs also work. Anything else is a `400`.                  |
| `stream`       | no       | `true` (default) streams Server-Sent Events. `false` returns one JSON document.                              |
| `topic`        | no       | Restrict the context to one topic: `healthcare-cybersecurity`, `healthcare-ai` or `ai-healthcare-law`.       |
| `max_articles` | no       | How many articles to give Claude, 1-20 (default 12).                                                         |
| `history`      | no       | Earlier turns for follow-up questions: up to 10 messages of up to 4000 characters, roles `user`/`assistant`. |

Retrieval ranks stored articles by keyword overlap with the question, then by their
own 1-10 relevance score, then by recency. A question with no keyword matches
(for example "what is the biggest story?") falls back to the highest-scored recent
articles. Send the same `topic` on follow-ups to keep the context consistent.

## Streaming response (`stream: true`)

`Content-Type: text/event-stream`. Events arrive in this order:

| Event   | Data                                                           | Meaning                                                                |
| ------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `meta`  | `{ "model": "...", "sources": [ { "n": 1, ... } ] }`           | Sent first. `sources` are the articles Claude was given, numbered.     |
| `delta` | `{ "text": "..." }`                                            | A piece of the answer. Append these in order.                          |
| `done`  | `{ "stopReason": "end_turn", "usage": {...}, "model": "..." }` | The answer is complete. `stopReason` can be `refusal` or `max_tokens`. |
| `error` | `{ "message": "..." }`                                         | The stream broke part-way; the text so far is incomplete.              |

Each source has `n`, `id`, `headline`, `source`, `url`, `published_at`, `topic` and
`relevance_score`. The answer cites them inline as `[1]`, `[2][3]`, so a UI can turn
those markers into links or hover cards using `meta.sources`.

Failures before any text is produced are real HTTP errors with a JSON body
`{ "error": "..." }`: `400` bad request, `401` no/wrong password, `413` body over
64 KB, `429` model rate limited, `502` the model call failed.

### Calling it from a browser

`EventSource` cannot send a POST body or an `Authorization` header, so read the
response stream with `fetch`:

```js
async function ask(question, password, onText, onSources) {
	const res = await fetch('https://news-app-backend.tom-dyar.workers.dev/chat', {
		method: 'POST',
		headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ question, model: 'sonnet' }),
	});
	if (!res.ok) throw new Error((await res.json()).error);

	const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = '';
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += value;
		let end;
		while ((end = buffer.indexOf('\n\n')) >= 0) {
			const frame = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			const [, event, data] = frame.match(/^event: (\w+)\ndata: (.*)$/s);
			const payload = JSON.parse(data);
			if (event === 'meta') onSources(payload.sources);
			if (event === 'delta') onText(payload.text);
			if (event === 'error') throw new Error(payload.message);
		}
	}
}
```

Use `AbortController` to let the user cancel; the server stops reading from Claude
when the connection closes.

### curl

```bash
curl -N https://news-app-backend.tom-dyar.workers.dev/chat \
  -H "Authorization: Bearer $NEWS_TRIGGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"question":"What ransomware news is there?","model":"haiku"}'
```

## Non-streaming response (`stream: false`)

```json
{
	"answer": "…with citations like [1]…",
	"sources": [{ "n": 1, "headline": "…", "url": "…" }],
	"model": "claude-sonnet-5-5",
	"stopReason": "end_turn",
	"usage": { "input_tokens": 3169, "output_tokens": 563 }
}
```

## Notes

- **Grounding.** Claude is told to answer only from the supplied articles, to cite
  them, and to say so when they don't cover the question. If the database has no
  articles, the reply says so without calling Claude.
- **Untrusted text.** Article text came from the open web. It is escaped and fenced
  in the prompt and Claude is told never to follow instructions inside it.
- **Models.** Haiku is fastest and cheapest, Sonnet is the balanced default, and Opus
  is the most capable. Only these three can be selected. Requests use low reasoning
  effort to keep the first words arriving quickly. For Sonnet and Opus the API's
  server-side refusal fallback is on, so a safety-classifier decline is retried on a
  fallback model instead of ending the answer (Haiku has no fallback).
- **Opus availability.** The Anthropic workspace currently has a 0 requests/minute
  limit on Opus, so choosing it returns `429` until that limit is raised in the
  Anthropic Console.
- **Browsers.** CORS allows the dashboard origin and `localhost`. The password must
  be entered by the user and kept in that browser only, exactly like the Refresh
  button; never ship it in page code.
