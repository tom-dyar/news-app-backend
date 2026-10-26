import { describe, expect, it } from "vitest";
import { isSevenAmEastern } from "../src/schedule";

describe("isSevenAmEastern", () => {
	it("is true at 11:00 UTC during daylight time (EDT)", () => {
		expect(isSevenAmEastern(new Date("2026-10-26T11:00:00Z"))).toBe(true);
		expect(isSevenAmEastern(new Date("2026-10-26T12:00:00Z"))).toBe(false);
	});
	it("is true at 12:00 UTC during standard time (EST)", () => {
		expect(isSevenAmEastern(new Date("2026-12-01T12:00:00Z"))).toBe(true);
		expect(isSevenAmEastern(new Date("2026-12-01T11:00:00Z"))).toBe(false);
	});
});
