import { ApiError } from "./api";

import type { ImplementationSnapshot } from "@chopin/protocol/implementation";

export function implementationEndpoint(room: string): string {
	return `/api/channels/${encodeURIComponent(room)}/implementation`;
}

export async function implementationResponse<T>(result: Response): Promise<T> {
	let value = await result.json();
	if (!result.ok) {
		// A machine the person chose is offline or no longer takes their work, or their choice
		// cannot be read: the server's sentence.
		let sentence = value.error === "machine-offline" || value.error === "machine-unavailable"
			|| value.error === "machine-choice-unavailable";
		let message = sentence && value.message ? value.message : value.error;
		throw new ApiError(message ?? "Build is unavailable", result.status);
	}
	return value;
}

/**
 * The planned `no-workspace` 409: no local agent is connected. A connected agent that is still
 * prototyping takes the build once it finishes, so busy is not offline.
 */
function offline(error: unknown): boolean {
	return error instanceof ApiError && error.status === 409 && error.message === "no-workspace";
}

/** The document and graph revisions a person reviewed, which Approve plan approves and nothing newer. */
export type Reviewed = { planRevision: number; graphVersion: number; graphRevision: number };

/**
 * Approve the snapshot's tasks and start building them on the viewer's local agent.
 *
 * The one place the browser starts a build. With `reviewed`, the server approves exactly the
 * revisions the person saw and refuses the start if the tasks changed since. `needs-agent` means
 * no connected agent could take it; any other refusal throws.
 */
export async function startBuild(
	room: string,
	snapshot: ImplementationSnapshot,
	reviewed?: Reviewed,
): Promise<"started" | "needs-agent"> {
	let graph = snapshot.graph;
	if (!graph) throw new ApiError("There are no tasks to build", 409);
	// The server picks the clicker's own connection; a snapshot can predate connecting.
	try {
		await implementationResponse(
			await fetch(implementationEndpoint(room), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...(snapshot.build ? { retryOf: snapshot.build.id } : {}),
					planRevision: reviewed?.planRevision ?? snapshot.planRevision,
					graphVersion: reviewed?.graphVersion ?? graph.number,
					graphRevision: reviewed?.graphRevision ?? graph.revision,
				}),
			}),
		);
		return "started";
	} catch (error) {
		if (offline(error)) return "needs-agent";
		throw error;
	}
}

/** Give up a one-click Build plan that is still waiting for its tasks. */
export async function cancelBuildRequest(room: string): Promise<void> {
	await implementationResponse(
		await fetch(`${implementationEndpoint(room)}/request`, { method: "DELETE" }),
	);
}

/** Stop this exact build, keeping its reported pull requests and local work. */
export async function stopBuild(room: string, id: string): Promise<void> {
	await implementationResponse(
		await fetch(`${implementationEndpoint(room)}/stop`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id }),
		}),
	);
}

/**
 * Create GitHub issues for the shown graph version's tasks: a parent and a sub-issue per task, with
 * the assignee picked for each (a login, `copilot`, or null). Answers once every step was tried.
 */
/** What an export made: the parent, and each task's issue or what stopped it. */
export type IssuesResult = {
	parent?: { number: number; url: string };
	/** An issue still waits for its sub-issue or blocked-by link. */
	pending?: true;
	tasks: Record<string, { number?: number; url?: string; problem?: string }>;
};

/**
 * Whether an export made the parent and an issue for every one of `taskIds`, with no problem and no
 * link left to make.
 */
export function issuesComplete(result: IssuesResult, taskIds: string[]): boolean {
	return !!result.parent && !result.pending
		&& taskIds.every(id => result.tasks[id]?.number !== undefined && !result.tasks[id]?.problem);
}

export async function createIssues(
	room: string,
	input: { graphNumber: number; graphRevision: number; assignees: Record<string, string | null> },
): Promise<IssuesResult> {
	return await implementationResponse<IssuesResult>(
		await fetch(`${implementationEndpoint(room)}/issues`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		}),
	);
}

/** Build the edits since the last build onto its pull requests, on the viewer's own agent. */
export async function rebuildChanges(room: string): Promise<void> {
	await implementationResponse(
		await fetch(`${implementationEndpoint(room)}/rebuild`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		}),
	);
}
