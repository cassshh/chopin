/**
 * web_search answered by Gemini with Google Search grounding, for deployments whose GitHub accounts
 * are not offered GitHub's own web_search. The research worker sees the same tool: one question in,
 * an answer with its sources out. The call uses the deployment's GEMINI_API_KEY, not the person's
 * GitHub token, so every admitted writer's searches go through the operator's key.
 *
 * Gemini names its sources by `vertexaisearch.cloud.google.com/grounding-api-redirect/…` links that
 * redirect to the page. Each is resolved to that page's own URL, which is what research cites and
 * checks; a source whose redirect can't be read is left out rather than cited by its opaque link.
 */
import { budgetedWebSearch, validTimeout } from "./web-search";

import type { ToolSet } from "ai";
import type { JobExecutionCredential } from "../jobs/registry";
import type { Result } from "./github-tools";
import type { WebSearchDeps, WebSearchSetupError } from "./web-search";

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
const REDIRECT_HOST = "vertexaisearch.cloud.google.com";
/** Sources one answer keeps; Gemini rarely grounds on more. */
const MAX_SOURCES = 10;
const MAX_ANSWER_CHARS = 20_000;
const RESOLVE_TIMEOUT_MS = 5_000;

type Credential = Extract<JobExecutionCredential, { kind: "active-planner" }>;
type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type GeminiSearchSettings = { apiKey: string; model: string };

/** A refusal from the Gemini API, with only its HTTP status kept. */
export class GeminiSearchError extends Error {
	constructor(readonly status: number) {
		super(`Gemini web_search failed with HTTP ${status}`);
		this.name = "GeminiSearchError";
	}
}

export type GeminiSource = { title: string; url: string };

/** The search's answer and the pages it stands on, as research reads a web_search result. */
export function searchResult(answer: string, sources: GeminiSource[]) {
	let listed = sources.map((source, index) => `[${index + 1}] ${source.title}: ${source.url}`);
	let text = [
		answer.trim() || "No answer was found.",
		...(listed.length ? ["", "Sources:", ...listed] : []),
	]
		.join("\n");
	return {
		content: [{ type: "text" as const, text }],
		citableSources: sources,
	};
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function httpsUrl(value: string): string | undefined {
	try {
		let url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

/** The page a grounding link redirects to, or the link itself when it is already a page. */
async function resolveSource(
	uri: string,
	fetcher: Fetch,
	signal: AbortSignal,
): Promise<string | undefined> {
	let url = httpsUrl(uri);
	if (!url) return undefined;
	if (new URL(url).hostname !== REDIRECT_HOST) return url;
	try {
		let response = await fetcher(url, {
			method: "GET",
			redirect: "manual",
			signal: AbortSignal.any([signal, AbortSignal.timeout(RESOLVE_TIMEOUT_MS)]),
		});
		await response.body?.cancel().catch(() => {});
		let location = response.status >= 300 && response.status < 400
			? response.headers.get("location")
			: null;
		let target = location ? httpsUrl(new URL(location, url).toString()) : undefined;
		return target && new URL(target).hostname !== REDIRECT_HOST ? target : undefined;
	} catch {
		return undefined;
	}
}

/** Read a generateContent answer: its text and the pages its grounding cites, resolved. */
export async function readGrounding(
	body: unknown,
	fetcher: Fetch,
	signal: AbortSignal,
): Promise<{ answer: string; sources: GeminiSource[] }> {
	let candidate = record((record(body)?.candidates as unknown[] | undefined)?.[0]);
	let parts = record(candidate?.content)?.parts;
	let answer = (Array.isArray(parts) ? parts : [])
		.map(part => record(part)?.text)
		.filter((text): text is string => typeof text === "string")
		.join("")
		.slice(0, MAX_ANSWER_CHARS);
	let chunks = record(candidate?.groundingMetadata)?.groundingChunks;
	let cited: Array<{ uri: string; title: string }> = [];
	for (let chunk of Array.isArray(chunks) ? chunks : []) {
		let web = record(record(chunk)?.web);
		if (typeof web?.uri !== "string") continue;
		let title = typeof web.title === "string" && web.title.trim() ? web.title.trim() : "Source";
		cited.push({ uri: web.uri, title: title.slice(0, 200) });
		if (cited.length >= MAX_SOURCES) break;
	}
	let resolved = await Promise.all(cited.map(item => resolveSource(item.uri, fetcher, signal)));
	let seen = new Set<string>();
	let sources: GeminiSource[] = [];
	for (let [index, url] of resolved.entries()) {
		if (!url || seen.has(url)) continue;
		seen.add(url);
		sources.push({ title: cited[index]!.title, url });
	}
	return { answer, sources };
}

export async function geminiSearchTool(
	credential: Credential,
	settings: GeminiSearchSettings,
	deps: WebSearchDeps & { fetch?: Fetch } = {},
): Promise<
	Result<{ tool: ToolSet["web_search"]; close: () => Promise<void> }, WebSearchSetupError>
> {
	// A grounded answer usually takes seconds; the GitHub tool's two minutes still bound it.
	let timeoutMs = validTimeout(deps.timeoutMs ?? 120_000);
	let fetcher: Fetch = deps.fetch ?? fetch;
	let endpoint = `${GEMINI_API}/models/${encodeURIComponent(settings.model)}:generateContent`;
	return {
		ok: true,
		value: {
			tool: budgetedWebSearch({
				credential,
				deps,
				timeoutMs,
				label: "Gemini web_search",
				description: "Research the public web for evidence about the disclosed research query. "
					+ "Google Search answers with the pages it used as sources. "
					+ "Ask one focused natural-language question per call. Split comparisons into separate questions.",
				search: async (input, options) => {
					let signal = options.abortSignal ?? AbortSignal.timeout(timeoutMs);
					let response = await fetcher(endpoint, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							"x-goog-api-key": settings.apiKey,
						},
						body: JSON.stringify({
							contents: [{ role: "user", parts: [{ text: input.query }] }],
							tools: [{ google_search: {} }],
						}),
						redirect: "error",
						signal,
					});
					if (!response.ok) {
						// The body can echo request details; only the status is kept.
						await response.body?.cancel().catch(() => {});
						throw new GeminiSearchError(response.status);
					}
					let { answer, sources } = await readGrounding(await response.json(), fetcher, signal);
					return searchResult(answer, sources);
				},
				classify: error =>
					error instanceof GeminiSearchError
						? `gemini:http:${error.status}`
						: error instanceof SyntaxError
						? "gemini:invalid-response"
						: error instanceof Error
						? "error"
						: "unknown",
			}),
			close: async () => {},
		},
	};
}
