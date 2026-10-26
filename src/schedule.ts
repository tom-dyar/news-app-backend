/**
 * Cron triggers run in UTC, so "7 AM Eastern" moves with daylight saving. The Worker is triggered at
 * both 11:00 and 12:00 UTC and only the one that lands on 7 AM in New York actually runs the pipeline.
 */
export function isSevenAmEastern(now: Date): boolean {
	const hour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(now);
	return Number(hour) === 7;
}
