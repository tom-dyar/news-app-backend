import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { claimRun } from "../src/runs";

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM agent_runs").run();
});

describe("claimRun", () => {
	it("claims when nothing has run recently", async () => {
		expect(await claimRun(env.DB, "test", 3600, 10_000)).toEqual({ claimed: true });
	});

	it("refuses inside the window and reports how long to wait", async () => {
		await claimRun(env.DB, "test", 3600, 10_000);
		expect(await claimRun(env.DB, "test", 3600, 10_600)).toEqual({ claimed: false, retryAfterSeconds: 3000 });
	});

	it("claims again once the window has passed", async () => {
		await claimRun(env.DB, "test", 3600, 10_000);
		expect(await claimRun(env.DB, "test", 3600, 13_601)).toEqual({ claimed: true });
	});

	it("a zero gap always claims (used by the scheduled run) but is still recorded", async () => {
		await claimRun(env.DB, "cron", 0, 10_000);
		expect(await claimRun(env.DB, "cron", 0, 10_000)).toEqual({ claimed: true });
		expect(await claimRun(env.DB, "public", 3600, 10_100)).toMatchObject({ claimed: false });
	});

	it("lets only one of several simultaneous callers win", async () => {
		const results = await Promise.all(Array.from({ length: 5 }, () => claimRun(env.DB, "race", 3600, 20_000)));
		expect(results.filter((r) => r.claimed)).toHaveLength(1);
	});
});
