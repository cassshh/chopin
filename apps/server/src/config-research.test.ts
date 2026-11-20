import { expect, test } from "bun:test";
import { configured } from "./config-conversation.test-fixtures";

test("RESEARCH_EVIDENCE_TIMEOUT_MS defaults to ten minutes", () => {
	expect(configured().researchEvidenceTimeoutMs).toBe(600_000);
});

test("RESEARCH_EVIDENCE_TIMEOUT_MS accepts whole milliseconds within its bounds", () => {
	for (let value of ["120000", "600000", "1800000"]) {
		expect(configured({ RESEARCH_EVIDENCE_TIMEOUT_MS: value }).researchEvidenceTimeoutMs)
			.toBe(Number(value));
	}
});

test("RESEARCH_EVIDENCE_TIMEOUT_MS rejects out-of-range and malformed values", () => {
	for (let value of ["", "119999", "1800001", "-1", "1e6", "600.5", "ten", "0x10", " 600000"]) {
		expect(() => configured({ RESEARCH_EVIDENCE_TIMEOUT_MS: value })).toThrow(
			"RESEARCH_EVIDENCE_TIMEOUT_MS must be an integer between 120000 and 1800000 milliseconds",
		);
	}
});

test("web search stays on GitHub's tool unless Gemini is chosen", () => {
	expect(configured().webSearch).toEqual({ provider: "copilot" });
	expect(configured({ GEMINI_API_KEY: "key" }).webSearch).toEqual({ provider: "copilot" });
	expect(configured({ WEB_SEARCH_PROVIDER: "copilot" }).webSearch).toEqual({ provider: "copilot" });
});

test("WEB_SEARCH_PROVIDER=gemini searches on GEMINI_API_KEY with the chosen model", () => {
	expect(configured({ WEB_SEARCH_PROVIDER: "gemini", GEMINI_API_KEY: "key" }).webSearch).toEqual({
		provider: "gemini",
		apiKey: "key",
		model: "gemini-3.8-flash",
	});
	expect(
		configured({
			WEB_SEARCH_PROVIDER: "gemini",
			GEMINI_API_KEY: "key",
			WEB_SEARCH_MODEL: "gemini-3.8-pro",
		}).webSearch,
	).toMatchObject({ model: "gemini-3.8-pro" });
});

test("a Gemini web search without its key, an unknown provider or a malformed model is refused", () => {
	expect(() => configured({ WEB_SEARCH_PROVIDER: "gemini" })).toThrow(
		"WEB_SEARCH_PROVIDER=gemini needs GEMINI_API_KEY",
	);
	expect(() => configured({ WEB_SEARCH_PROVIDER: "bing" })).toThrow(
		"WEB_SEARCH_PROVIDER must be copilot or gemini",
	);
	expect(() =>
		configured({
			WEB_SEARCH_PROVIDER: "gemini",
			GEMINI_API_KEY: "key",
			WEB_SEARCH_MODEL: "../models/x",
		})
	).toThrow("WEB_SEARCH_MODEL must be a Gemini model name");
});
