import { expect, it } from "bun:test";

import { geminiSearchTool, readGrounding } from "./gemini-search";
import { observedWebSourceUrls } from "../jobs/research-workspace";

import type { JobExecutionCredential } from "../jobs/registry";

function credential(): Extract<JobExecutionCredential, { kind: "active-planner" }> {
	return {
		kind: "active-planner",
		token: "ghu_owner",
		ownerSessionId: "owner",
		ownerGeneration: 1,
		credentialRevision: 1,
		expiresAt: new Date(Date.now() + 60_000),
		authorize: async () => true,
	};
}

const REDIRECT = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/";
const SETTINGS = { apiKey: "AIza-secret-key", model: "gemini-3.8-flash" };

function grounded(chunks: Array<{ uri: string; title?: string }>, text = "Bun 1.4.4 is current.") {
	return {
		candidates: [{
			content: { parts: [{ text }] },
			groundingMetadata: { groundingChunks: chunks.map(web => ({ web })) },
		}],
	};
}

/** Answers generateContent with `body`, and each grounding redirect with its page or `status`. */
function fakeFetch(body: unknown, pages: Record<string, string | number> = {}) {
	let requests: Array<{ url: string; init?: RequestInit }> = [];
	let fetcher = async (input: string | URL, init?: RequestInit) => {
		let url = String(input);
		requests.push({ url, init });
		if (url.startsWith(REDIRECT)) {
			let page = pages[url.slice(REDIRECT.length)];
			if (typeof page === "number") return new Response(null, { status: page });
			if (page === undefined) throw new TypeError("network down");
			return new Response(null, { status: 302, headers: { location: page } });
		}
		return typeof body === "number"
			? new Response('{"error":{"message":"key AIza-secret-key quota"}}', { status: body })
			: Response.json(body);
	};
	return { fetcher, requests };
}

async function search(
	fetcher: ReturnType<typeof fakeFetch>["fetcher"],
	log: string[] = [],
	calls: unknown[] = [],
) {
	let owner = credential();
	let loaded = await geminiSearchTool(owner, SETTINGS, {
		fetch: fetcher,
		log: line => log.push(line),
		onCall: (result, error, diagnostic) => void calls.push({ result, error, diagnostic }),
	});
	if (!loaded.ok) throw new Error("setup failed");
	return loaded.value.tool.execute!({ query: "latest bun?" }, {
		context: { credential: owner },
		toolCallId: "call",
		messages: [],
	} as never);
}

it("asks Gemini with Google Search on the deployment key and cites the pages behind its links", async () => {
	let { fetcher, requests } = fakeFetch(
		grounded([
			{ uri: `${REDIRECT}a`, title: "bun.com" },
			{ uri: `${REDIRECT}b`, title: "npmjs.com" },
		]),
		{ a: "https://bun.com/blog/bun-v1.4", b: "https://www.npmjs.com/package/bun" },
	);
	let result = await search(fetcher);
	let call = requests[0]!;
	expect(call.url).toBe(
		"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
	);
	expect(new Headers(call.init?.headers).get("x-goog-api-key")).toBe("AIza-secret-key");
	expect(JSON.parse(String(call.init?.body))).toEqual({
		contents: [{ role: "user", parts: [{ text: "latest bun?" }] }],
		tools: [{ google_search: {} }],
	});
	expect(result).toEqual({
		content: [{
			type: "text",
			text: "Bun 1.4.4 is current.\n\nSources:\n[1] bun.com: https://bun.com/blog/bun-v1.4\n"
				+ "[2] npmjs.com: https://www.npmjs.com/package/bun",
		}],
		citableSources: [
			{ title: "bun.com", url: "https://bun.com/blog/bun-v1.4" },
			{ title: "npmjs.com", url: "https://www.npmjs.com/package/bun" },
		],
	});
	// Research counts exactly those pages as sources it may cite.
	expect(observedWebSourceUrls(result).sort()).toEqual([
		"https://bun.com/blog/bun-v1.4",
		"https://www.npmjs.com/package/bun",
	]);
});

it("leaves out a source whose redirect can't be read, is not HTTPS, or repeats another", async () => {
	let { fetcher } = fakeFetch({}, {
		ok: "https://example.com/page",
		again: "https://example.com/page",
		plain: "http://example.com/insecure",
		gone: 404,
	});
	let read = await readGrounding(
		grounded([
			{ uri: `${REDIRECT}ok` },
			{ uri: `${REDIRECT}again` },
			{ uri: `${REDIRECT}plain` },
			{ uri: `${REDIRECT}gone` },
			{ uri: `${REDIRECT}unreachable` },
			{ uri: "https://docs.example.org/direct", title: "docs" },
		]),
		fetcher,
		new AbortController().signal,
	);
	expect(read.sources).toEqual([
		{ title: "Source", url: "https://example.com/page" },
		{ title: "docs", url: "https://docs.example.org/direct" },
	]);
});

it("an answer without grounding says so and cites nothing", async () => {
	let { fetcher } = fakeFetch({ candidates: [{ content: { parts: [{ text: "" }] } }] });
	expect(await search(fetcher)).toEqual({
		content: [{ type: "text", text: "No answer was found." }],
		citableSources: [],
	});
});

it("a refused call is classified by its status alone, never the key or Gemini's words", async () => {
	let log: string[] = [];
	let calls: Array<{ diagnostic?: { webFailure: string } }> = [];
	let { fetcher } = fakeFetch(429);
	await expect(search(fetcher, log, calls)).rejects.toThrow(
		"Gemini web_search failed with HTTP 429",
	);
	expect(log).toEqual(["chopin: web_search failed - local:request:gemini:http:429"]);
	expect(calls.at(-1)?.diagnostic?.webFailure).toBe("local:request:gemini:http:429");
	expect(JSON.stringify({ log, calls })).not.toContain("AIza-secret-key");
});

it("binds each call to the research owner's credential", async () => {
	let { fetcher } = fakeFetch(grounded([]));
	let loaded = await geminiSearchTool(credential(), SETTINGS, { fetch: fetcher });
	if (!loaded.ok) throw new Error("setup failed");
	await expect(loaded.value.tool.execute!({ query: "q" }, {
		context: { credential: credential() },
	} as never)).rejects.toThrow("Gemini web_search authorization ended");
});
