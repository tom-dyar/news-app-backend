import { describe, expect, it } from "vitest";
import { bearerMatches, verifySlackSignature } from "../src/auth";

describe("bearerMatches", () => {
	it("accepts the exact token", async () => {
		expect(await bearerMatches("Bearer s3cret-token", "s3cret-token")).toBe(true);
	});
	it("rejects wrong, missing, malformed, or empty-expected tokens", async () => {
		expect(await bearerMatches("Bearer nope", "s3cret-token")).toBe(false);
		expect(await bearerMatches("Bearer s3cret-token-extra", "s3cret-token")).toBe(false);
		expect(await bearerMatches(null, "s3cret-token")).toBe(false);
		expect(await bearerMatches("s3cret-token", "s3cret-token")).toBe(false);
		expect(await bearerMatches("Basic s3cret-token", "s3cret-token")).toBe(false);
		expect(await bearerMatches("Bearer ", "")).toBe(false);
		expect(await bearerMatches("Bearer anything", undefined)).toBe(false);
	});
});

async function sign(secret: string, ts: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`));
	return "v0=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("verifySlackSignature", () => {
	const secret = "slack-signing-secret";
	const body = "command=%2Fnews&user_id=U1&response_url=https%3A%2F%2Fhooks.slack.com%2Fx";
	const now = 1_800_000_000;
	const ts = String(now);

	it("accepts a correctly signed, fresh request", async () => {
		expect(await verifySlackSignature(secret, ts, await sign(secret, ts, body), body, now)).toBe(true);
	});
	it("rejects a tampered body, wrong secret, and malformed or missing signature", async () => {
		const sig = await sign(secret, ts, body);
		expect(await verifySlackSignature(secret, ts, sig, body + "&x=1", now)).toBe(false);
		expect(await verifySlackSignature("other", ts, sig, body, now)).toBe(false);
		expect(await verifySlackSignature(secret, ts, "v0=zz", body, now)).toBe(false);
		expect(await verifySlackSignature(secret, ts, null, body, now)).toBe(false);
		expect(await verifySlackSignature(secret, null, sig, body, now)).toBe(false);
	});
	it("rejects stale (replayed) timestamps beyond 5 minutes", async () => {
		const old = String(now - 301);
		expect(await verifySlackSignature(secret, old, await sign(secret, old, body), body, now)).toBe(false);
		const ok = String(now - 299);
		expect(await verifySlackSignature(secret, ok, await sign(secret, ok, body), body, now)).toBe(true);
	});
});
