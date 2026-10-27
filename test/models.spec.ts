import { describe, expect, it } from "vitest";
import { MODELS, resolveModel } from "../src/models";

describe("resolveModel", () => {
	it("defaults to Sonnet when no preference is given", () => {
		for (const pref of [undefined, null, "", "   "]) expect(resolveModel(pref)?.id).toBe("claude-sonnet-5-5");
	});
	it("accepts friendly aliases, case-insensitively", () => {
		expect(resolveModel("haiku")?.id).toBe("claude-haiku-5-5");
		expect(resolveModel("Sonnet")?.id).toBe("claude-sonnet-5-5");
		expect(resolveModel("OPUS")?.id).toBe("claude-opus-5-5");
	});
	it("accepts exact model IDs", () => {
		for (const m of MODELS) expect(resolveModel(m.id)?.id).toBe(m.id);
	});
	it("rejects anything not on the allow-list (no passing arbitrary model strings upstream)", () => {
		for (const bad of ["gpt-4", "claude-sonnet-5-5-20990101", "claude-fable-5-1", "sonnet; drop", 42, {}, []]) expect(resolveModel(bad)).toBeNull();
	});
	it("the fast model keeps low reasoning effort; the others think a little more for advice", () => {
		expect(resolveModel("haiku")?.effort).toBe("low");
		expect(resolveModel("sonnet")?.effort).toBe("medium");
		expect(resolveModel("opus")?.effort).toBe("medium");
	});
	it("only Sonnet and Opus use the server-side refusal fallback (Haiku has none)", () => {
		expect(resolveModel("haiku")?.fallbacks).toBe(false);
		expect(resolveModel("sonnet")?.fallbacks).toBe(true);
		expect(resolveModel("opus")?.fallbacks).toBe(true);
	});
});
