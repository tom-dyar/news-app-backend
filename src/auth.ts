const enc = new TextEncoder();

async function sha256(s: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", enc.encode(s));
}

/** Constant-time string comparison (both sides are hashed first so lengths always match). */
async function safeEqual(a: string, b: string): Promise<boolean> {
	return crypto.subtle.timingSafeEqual(await sha256(a), await sha256(b));
}

/** True when `Authorization: Bearer <token>` matches the configured token. An unset/empty token never matches. */
export async function bearerMatches(header: string | null, expected: string | undefined): Promise<boolean> {
	if (!expected || !header?.startsWith("Bearer ")) return false;
	return safeEqual(header.slice("Bearer ".length), expected);
}

const MAX_SKEW_SECONDS = 300;

/** Verify Slack's request signature (v0 scheme) and reject timestamps older than 5 minutes to stop replays. */
export async function verifySlackSignature(secret: string, timestamp: string | null, signature: string | null, body: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
	if (!timestamp || !signature) return false;
	const ts = Number(timestamp);
	if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return false;
	const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${timestamp}:${body}`));
	const expected = "v0=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return safeEqual(signature, expected);
}
