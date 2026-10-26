export type Claim = { claimed: true } | { claimed: false; retryAfterSeconds: number };

const KEEP_SECONDS = 7 * 24 * 3600;

/**
 * Atomically record a pipeline run unless another one started within `minGapSeconds`.
 * The check and the insert are one SQL statement, so simultaneous callers can't both win.
 * A gap of 0 always succeeds (scheduled runs) but is still logged, so it counts against everyone else.
 */
export async function claimRun(db: D1Database, source: string, minGapSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): Promise<Claim> {
	const [insert] = await db.batch([
		db
			.prepare(`INSERT INTO agent_runs (started_at, source) SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM agent_runs WHERE started_at > ?1 - ?3)`)
			.bind(nowSeconds, source, minGapSeconds),
		db.prepare(`DELETE FROM agent_runs WHERE started_at < ?`).bind(nowSeconds - KEEP_SECONDS),
	]);
	if (insert.meta.changes === 1) return { claimed: true };
	const last = await db.prepare(`SELECT MAX(started_at) AS last FROM agent_runs`).first<{ last: number }>();
	return { claimed: false, retryAfterSeconds: Math.max(1, (last?.last ?? nowSeconds) + minGapSeconds - nowSeconds) };
}
