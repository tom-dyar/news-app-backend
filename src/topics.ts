export interface Topic {
	id: string;
	label: string;
	/** Extra steer for the search prompt. */
	focus: string;
}

export const TOPICS: Topic[] = [
	{
		id: "healthcare-cybersecurity",
		label: "cybersecurity in healthcare",
		focus: "ransomware, data breaches, HIPAA enforcement, hospital/health-system attacks, medical device security, healthcare cyber policy",
	},
	{
		id: "healthcare-ai",
		label: "AI advances in healthcare",
		focus: "clinical AI, diagnostics, FDA-cleared AI tools, generative AI in health systems, drug discovery, major research results",
	},
	{
		id: "ai-healthcare-law",
		label: "law enforcement and legal rulings regarding AI and healthcare",
		focus: "court rulings, regulatory enforcement actions, state/federal AI-in-healthcare laws, DOJ/FTC/HHS actions, lawsuits over health AI",
	},
];

export const MAX_ARTICLES_PER_TOPIC = 20;

/** Resolve a user-supplied topic (id or label, case-insensitive) to its stored label. */
export function resolveTopic(input: string): string | null {
	const q = input.trim().toLowerCase();
	const t = TOPICS.find((t) => t.id === q || t.label.toLowerCase() === q);
	return t ? t.label : null;
}
