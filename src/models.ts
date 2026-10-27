export interface ModelInfo {
	/** Short name clients can send, e.g. "sonnet". */
	alias: string;
	id: string;
	label: string;
	/** Whether the Claude API's server-side refusal fallback is available for this model (not for Haiku). */
	fallbacks: boolean;
}

// An allow-list: the "model preference" in a request is looked up here and never forwarded as-is,
// so a caller can't pick an arbitrary (or far more expensive) model.
export const MODELS: ModelInfo[] = [
	{ alias: "haiku", id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest, cheapest)", fallbacks: false },
	{ alias: "sonnet", id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (balanced)", fallbacks: true },
	{ alias: "opus", id: "claude-opus-5-5", label: "Claude Opus 5.5 (most capable)", fallbacks: true },
];

export const DEFAULT_MODEL_ALIAS = "sonnet";
const DEFAULT_MODEL = MODELS.find((m) => m.alias === DEFAULT_MODEL_ALIAS)!;

/** Resolve a preference (alias or exact ID, case-insensitive; empty means default). Null if not allowed. */
export function resolveModel(preference: unknown): ModelInfo | null {
	if (preference == null) return DEFAULT_MODEL;
	if (typeof preference !== "string") return null;
	const p = preference.trim().toLowerCase();
	if (p === "") return DEFAULT_MODEL;
	return MODELS.find((m) => m.alias === p || m.id === p) ?? null;
}
