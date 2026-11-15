/**
 * Exporting an implementation graph as GitHub issues: one parent issue for the document, a
 * sub-issue per task, "blocked by" links from the tasks' dependencies, and the assignee a writer
 * picked. The server creates them with the presser's GitHub App user token; the Planner never does.
 *
 * GitHub is written first and the result committed after each step, so a step that failed, or a
 * process that stopped, is resumed by pressing again: an issue Chopin recorded is never created
 * twice. Every body ends with a hidden marker naming its document and task, so an issue whose
 * creation answer was lost, or whose reference could not be saved, is found again by the next press
 * instead of being made a second time.
 */
import { z } from "zod";
import { GitHubError } from "../github/client";
import { exclusive, persistExclusive } from "../plan/service";
import { announceImplementation } from "./notifications";
import { buildActive } from "./builds";
import { endExport, exporting, startExport } from "./exporting";
import { unapprovedDecisions } from "./open-decisions";

import type { GitHubAssignment, GitHubIssueBody, GitHubIssueRef } from "../github/client";
import type { Plan } from "../plan/service";
import type { Record as DecisionRecord } from "../questions/records";
import type { Graph, Task, Version } from "./graphs";
import type { IssueExportSnapshot } from "@chopin/protocol/implementation";

/** The assignee value that asks for Copilot's coding agent rather than a person. */
export const COPILOT = "copilot";
const COPILOT_LOGIN = "copilot-swe-agent[bot]";
/** GitHub caps an issue body at 65,536 characters. */
const MAX_BODY = 60_000;
const MAX_FIELD = 12_000;
export const MAX_EXPORTED_TASKS = 100;
/** The longest task ID an export stores; `restoreIssues` refuses a longer one. */
export const MAX_EXPORTED_TASK_ID = 128;
/** Said when GitHub can't list the issues an earlier press may have made but not recorded. */
export const RECOVERY_FAILED =
	"Couldn't check GitHub for issues an earlier try may have made, so nothing new was made. Try again.";

/** The most earlier presses whose unrecorded issues an export still looks for. */
const MAX_UNRESOLVED = 10;

/**
 * A task ID an export can keep as a key: bounded as `restoreIssues` requires, and not `__proto__`,
 * which an object takes as its prototype and JSON then drops.
 */
export function storableTaskId(id: string): boolean {
	return id.length > 0 && id.length <= MAX_EXPORTED_TASK_ID && id !== "__proto__";
}

/** The hidden line that ends a document's parent issue. */
export function parentMarker(channelId: string): string {
	return `<!-- chopin:${channelId} -->`;
}

/** The hidden line that ends a task's issue. */
export function taskMarker(channelId: string, taskId: string): string {
	return `<!-- chopin:${channelId}:${taskId} -->`;
}

let login = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);
let refSchema = z.object({
	id: z.number().int().positive(),
	number: z.number().int().positive(),
	url: z.string().url().max(500),
}).strict();
let entrySchema = z.object({
	issue: refSchema.optional(),
	/** A GitHub login, or `copilot`. Absent: unassigned. */
	assignee: z.union([login, z.literal(COPILOT)]).optional(),
	/** Whether the assignee is on the issue. */
	assigned: z.literal(true).optional(),
	/** Whether the issue is a sub-issue of the parent. */
	linked: z.literal(true).optional(),
	/** The tasks whose issues this one is marked blocked by. */
	blockedBy: z.array(z.string().min(1).max(128)).max(MAX_EXPORTED_TASKS).optional(),
	/** Why the last attempt at this task's issue stopped short, in plain words. */
	problem: z.string().min(1).max(300).optional(),
}).strict();
let exportSchema = z.object({
	graphNumber: z.number().int().positive(),
	graphRevision: z.number().int().positive(),
	/** The GitHub login of whoever pressed last. */
	by: login,
	at: z.string().datetime(),
	/**
	 * Earlier presses that left something unmade, each with its presser and start: the issues the
	 * next press looks among for one made but never recorded. Cleared once every issue is recorded.
	 */
	unresolved: z.array(z.object({ by: login, at: z.string().datetime() }).strict())
		.max(MAX_UNRESOLVED)
		.optional(),
	parent: refSchema.optional(),
	problem: z.string().min(1).max(300).optional(),
	/**
	 * Issues of tasks no longer in the graph, still to be closed as not planned. A task that comes
	 * back before its issue is closed takes the issue back.
	 */
	removed: z.array(z.object({ task: z.string().min(1).max(128), issue: refSchema }).strict())
		.max(MAX_EXPORTED_TASKS)
		.optional(),
	tasks: z.record(z.string().min(1).max(128), entrySchema).refine(
		tasks => Object.keys(tasks).length <= MAX_EXPORTED_TASKS,
	),
}).strict();

/** The issues a document's tasks were exported as, kept in the sidecar beside the graph. */
export type IssueExport = z.infer<typeof exportSchema>;
type Entry = z.infer<typeof entrySchema>;

/** Restore a stored export; an invalid one rejects the sidecar rather than dropping silently. */
export function restoreIssues(value: unknown): IssueExport {
	return exportSchema.parse(value);
}

/** Per-task assignee choices from the browser: a login, `copilot`, or null for unassigned. */
export const assigneesSchema = z.record(
	z.string().min(1).max(128),
	z.union([login, z.literal(COPILOT), z.null()]),
).refine(value => Object.keys(value).length <= MAX_EXPORTED_TASKS);

/**
 * The GitHub issues of the tasks a build implements, for the coding agent: each pull request that
 * implements a task says `Closes #n`, so GitHub links it to the task's issue and closes the issue
 * when it merges. Nothing when the tasks were never made into issues.
 */
export function issueLinks(plan: { issues?: IssueExport; graph?: Graph }): {
	issues?: {
		instructions: string;
		parent?: { number: number; url: string };
		tasks: Record<string, { number: number; url: string }>;
	};
} {
	let issues = plan.issues;
	let graph = plan.graph?.versions.at(-1);
	if (!issues || !graph) return {};
	let tasks = Object.fromEntries(
		graph.definition.tasks.flatMap(task => {
			let issue = issues.tasks[task.id]?.issue;
			return issue ? [[task.id, { number: issue.number, url: issue.url }]] : [];
		}),
	);
	if (Object.keys(tasks).length === 0) return {};
	return {
		issues: {
			instructions:
				"These tasks are GitHub issues. In the body of the pull request that implements a task, put a line `Closes #<number>` for that task's issue, one line per task it implements, so GitHub links the pull request and closes the issue when it merges.",
			...(issues.parent
				? { parent: { number: issues.parent.number, url: issues.parent.url } }
				: {}),
			tasks,
		},
	};
}

/** What the browser shows of an export: issue links, assignees and any step that failed. */
export function issuesSnapshot(plan: Plan, running: boolean): IssueExportSnapshot | undefined {
	let issues = plan.issues;
	if (!issues) return;
	let graph = plan.graph?.versions.at(-1);
	return {
		by: issues.by,
		current: graph?.number === issues.graphNumber && graph.revision === issues.graphRevision,
		running,
		...(issues.parent ? { parent: { number: issues.parent.number, url: issues.parent.url } } : {}),
		...(issues.problem ? { problem: issues.problem } : {}),
		tasks: Object.fromEntries(
			Object.entries(issues.tasks).map(([id, entry]) => [id, {
				...(entry.issue ? { number: entry.issue.number, url: entry.issue.url } : {}),
				...(entry.assignee ? { assignee: entry.assignee } : {}),
				...(entry.assigned ? { assigned: true as const } : {}),
				...(entry.problem ? { problem: entry.problem } : {}),
			}]),
		),
	};
}

function clip(text: string, limit = MAX_FIELD): string {
	let trimmed = text.trim();
	return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

/** Answered decisions as `question: answer`, with the why when there is one. */
function decided(records: Iterable<DecisionRecord>): string[] {
	let lines: string[] = [];
	for (let record of records) {
		if (record.status !== "answered") continue;
		for (let question of record.definition.questions) {
			let chosen = question.options
				.filter(option => record.choices?.includes(option.id))
				.map(option => option.label);
			let written = record.answers?.[question.id]?.trim();
			let answer = [...chosen, ...(written ? [written] : [])].join(", ");
			if (!answer) continue;
			let prompt = question.question.replace(/\s+/g, " ").trim();
			lines.push(`- **${prompt}** ${answer.replace(/\s+/g, " ")}`);
		}
		if (record.why?.trim()) lines.push(`  - Why: ${record.why.replace(/\s+/g, " ").trim()}`);
	}
	return lines;
}

function stillOpen(records: Iterable<DecisionRecord>): string[] {
	return unapprovedDecisions(records).map(item => {
		let prompt = item.prompt.replace(/\s+/g, " ").trim();
		return item.options.length > 0 ? `- ${prompt} (${item.options.join(", ")})` : `- ${prompt}`;
	});
}

/** The parent issue: what the tasks come from, and what the team decided or left open. */
export function parentIssue(input: {
	title: string;
	url: string;
	channelId: string;
	records: Iterable<DecisionRecord>;
}): { title: string; body: string } {
	let records = [...input.records];
	let decisions = decided(records);
	let open = stillOpen(records);
	let body = [
		`Tasks for [${input.title}](${input.url}), broken down in Chopin from the document and its repository. Each task is a sub-issue of this one.`,
		...(decisions.length ? ["", "## Decided", "", ...decisions] : []),
		...(open.length
			? [
				"",
				"## Still open",
				"",
				"These decisions were not answered when the tasks were written. The tasks go ahead on best judgment; check the document before relying on them.",
				"",
				...open,
			]
			: []),
	].join("\n");
	// The marker is added after clipping, so a long body never loses it.
	return {
		title: clip(input.title, 250) || "Implementation tasks",
		body: `${clip(body, MAX_BODY)}\n\n${parentMarker(input.channelId)}`,
	};
}

/** One task's issue: its context, goal, acceptance criteria and the issues it waits on. */
export function taskIssue(input: {
	task: Task;
	parent: number;
	dependencies: Array<{ number: number; title: string }>;
	title: string;
	url: string;
	channelId: string;
	open: boolean;
}): { title: string; body: string } {
	let { task } = input;
	let body = [
		clip(task.context),
		"",
		"## Goal",
		"",
		clip(task.goal),
		...(task.acceptance.length
			? [
				"",
				"## Acceptance criteria",
				"",
				...task.acceptance.map(item => `- [ ] ${clip(item, 2000).replace(/\s+/g, " ")}`),
			]
			: []),
		...(input.dependencies.length
			? ["", "## Depends on", "", ...input.dependencies.map(item => `- #${item.number}`)]
			: []),
		"",
		"---",
		"",
		`Part of #${input.parent}, from [${input.title}](${input.url}) in Chopin.${
			input.open ? ` Some decisions are still open; see #${input.parent}.` : ""
		}`,
	].join("\n");
	return {
		title: clip(task.title, 250),
		body: `${clip(body, MAX_BODY)}\n\n${taskMarker(input.channelId, task.id)}`,
	};
}

/** Tasks with every dependency before them, in the graph's order otherwise. */
export function dependencyOrder(tasks: Task[]): Task[] {
	let byId = new Map(tasks.map(task => [task.id, task]));
	let done = new Set<string>();
	let ordered: Task[] = [];
	let visit = (task: Task, path: Set<string>) => {
		if (done.has(task.id) || path.has(task.id)) return;
		path.add(task.id);
		for (let id of task.dependsOn) {
			let dependency = byId.get(id);
			if (dependency) visit(dependency, path);
		}
		path.delete(task.id);
		done.add(task.id);
		ordered.push(task);
	};
	for (let task of tasks) visit(task, new Set());
	return ordered;
}

/** Why an issue was made but not assigned when the App may only read issues. */
export const READ_ONLY_ISSUES =
	"Made, but not assigned: Chopin's GitHub App can only read issues. Give it Issues: Read and write, then accept the change on its installation, and press Create missing issues.";

/** A failed GitHub step in plain words. */
export function problemFor(
	error: unknown,
	step: "create" | "link" | "block" | "assign" | "close",
): string {
	let status = error instanceof GitHubError ? error.status : undefined;
	if (status === 429) return "GitHub's rate limit was reached. Try again in a few minutes.";
	if (status === 410) return "Issues are turned off for this repository.";
	if (step === "assign") {
		return "Couldn't assign this issue. Check that the person can be assigned here, or that Copilot coding agent is enabled for the repository.";
	}
	if (status === 401 || status === 403 || status === 404) {
		return "Chopin's GitHub App can't write issues here. Give it Issues: Read and write, then try again.";
	}
	if (step === "close" && status === 422) {
		return "GitHub refused to close the issue of a task removed from the document.";
	}
	if (status === 422) {
		return step === "create"
			? "GitHub refused this issue."
			: step === "link"
			? "GitHub refused to make this a sub-issue."
			: "GitHub refused the blocked-by link.";
	}
	return "GitHub couldn't be reached. Try again.";
}

export type IssueWriter = {
	createIssue(input: { title: string; body: string }): Promise<GitHubIssueRef>;
	addSubIssue(parent: number, child: number): Promise<void>;
	addBlockedBy(issue: number, blocker: number): Promise<void>;
	addAssignees(issue: number, assignment: GitHubAssignment): Promise<string[]>;
	/** Issues `creator` opened that changed since `since`; optional where they can't be listed. */
	issuesBy?(creator: string, since: string): Promise<GitHubIssueBody[]>;
	/** Close an issue as not planned; optional where issues are never closed. */
	closeIssue?(issue: number): Promise<void>;
};

export type ExportContext = {
	channelId: string;
	title: string;
	url: string;
	/** `owner/name`, for Copilot's assignment. */
	repository: string;
	defaultBranch?: string;
	/** False when the App may only read issues: issues are still made and linked, never assigned. */
	canAssign?: boolean;
	/** Runs `action` with the room locked, as the routes' `withPlan` does. */
	withPlan<T>(action: (plan: Plan) => Promise<T>): Promise<T>;
	github: IssueWriter;
};

export { exporting };

/** Commit a change to the export, or refuse when the graph it was made for has moved on. */
async function commit(
	plan: Plan,
	expected: { graphNumber: number; graphRevision: number },
	change: (issues: IssueExport) => void,
): Promise<void> {
	await exclusive(plan, async () => {
		let issues = plan.issues;
		if (
			!issues || issues.graphNumber !== expected.graphNumber
			|| issues.graphRevision !== expected.graphRevision
		) {
			throw new GitHubError("the tasks changed while their issues were being created", 409);
		}
		let previous = structuredClone(issues);
		change(issues);
		try {
			await persistExclusive(plan);
		} catch (error) {
			plan.issues = previous;
			throw error;
		}
		announceImplementation(plan);
	});
}

/**
 * One GitHub write of the export. GitHub's refusal is recorded as the task's problem and answers
 * false; a failure to record it, like any failure to save, ends the press.
 */
async function step(
	write: () => Promise<unknown>,
	record: (problem: string) => Promise<void>,
	kind: Parameters<typeof problemFor>[1],
	log?: (error: unknown) => void,
): Promise<boolean> {
	try {
		await write();
		return true;
	} catch (error) {
		log?.(error);
		await record(problemFor(error, kind));
		return false;
	}
}

/**
 * The parent and task issues an earlier press made but did not record, found by the marker at the
 * end of their bodies among each earlier presser's issues since their press. Throws when a
 * listing fails.
 */
async function recover(
	context: ExportContext,
	tasks: Task[],
	current: IssueExport,
	presses: Array<{ by: string; at: string }>,
): Promise<{ parent?: GitHubIssueRef; tasks: Map<string, GitHubIssueRef> }> {
	let found = {
		parent: undefined as GitHubIssueRef | undefined,
		tasks: new Map<string, GitHubIssueRef>(),
	};
	let issuesBy = context.github.issuesBy;
	if (!issuesBy) return found;
	// Each earlier presser's own issues since their press, with a minute's slack for a clock GitHub
	// and this server disagree on. Only those, so an issue someone else wrote the marker into is
	// never taken.
	// A listing that fails proves nothing about what is there, so it ends the press rather than
	// making an issue that may already exist.
	let listed = (await Promise.all(
		presses.map(press => issuesBy(press.by, new Date(Date.parse(press.at) - 60_000).toISOString())),
	)).flat();
	let ended = (body: string, marker: string) => body.trimEnd().endsWith(marker);
	// Oldest first, so the first issue made for a task is the one kept.
	for (let issue of [...listed].sort((a, b) => a.number - b.number)) {
		let ref = { id: issue.id, number: issue.number, url: issue.url };
		if (!current.parent && !found.parent && ended(issue.body, parentMarker(context.channelId))) {
			found.parent = ref;
			continue;
		}
		for (let task of tasks) {
			if (current.tasks[task.id]?.issue || found.tasks.has(task.id)) continue;
			if (ended(issue.body, taskMarker(context.channelId, task.id))) {
				found.tasks.set(task.id, ref);
				break;
			}
		}
	}
	return found;
}

function latest(plan: Plan): Version {
	let graph = plan.graph?.versions.at(-1);
	if (!graph || graph.definition.tasks.length === 0) {
		throw new GitHubError("there are no tasks to create issues for", 409);
	}
	return graph;
}

/**
 * Create the issues a graph version still lacks. Refuses while another export of the document runs
 * or when the version shown is no longer the latest. Issues created for an earlier version of the
 * graph are kept for the tasks that still have the same ID; edits to such a task do not reach its
 * issue.
 */
export async function exportIssues(
	context: ExportContext,
	input: {
		graphNumber: number;
		graphRevision: number;
		by: string;
		assignees: Record<string, string | null>;
	},
): Promise<IssueExport> {
	if (!startExport(context.channelId)) {
		throw new GitHubError("issues are already being created for this document", 409);
	}
	try {
		return await run(context, input);
	} finally {
		endExport(context.channelId);
		await context.withPlan(async plan => announceImplementation(plan)).catch(() => {});
	}
}

async function run(
	context: ExportContext,
	input: {
		graphNumber: number;
		graphRevision: number;
		by: string;
		assignees: Record<string, string | null>;
	},
): Promise<IssueExport> {
	let expected = { graphNumber: input.graphNumber, graphRevision: input.graphRevision };
	// The intent first: the version, who pressed, and the assignees picked for issues not yet made.
	let { tasks, records } = await context.withPlan(plan =>
		exclusive(plan, async () => {
			let graph = latest(plan);
			if (graph.number !== input.graphNumber || graph.revision !== input.graphRevision) {
				throw new GitHubError("the tasks have changed; reload and try again", 409);
			}
			// A build being started or run has these tasks; issues made now could hand them to
			// someone else too, and the build would read half their links.
			if (buildActive(plan)) {
				throw new GitHubError(
					"a build of these tasks is under way; create issues once it ends",
					409,
				);
			}
			if (graph.definition.tasks.length > MAX_EXPORTED_TASKS) {
				throw new GitHubError(`at most ${MAX_EXPORTED_TASKS} tasks can become issues`, 409);
			}
			// Stored IDs are bounded on restore and must be ordinary keys, so any other is refused
			// before anything is kept.
			let unstorable = graph.definition.tasks.find(task => !storableTaskId(task.id));
			if (unstorable) {
				throw new GitHubError(
					unstorable.id.length > MAX_EXPORTED_TASK_ID
						? `a task ID longer than ${MAX_EXPORTED_TASK_ID} characters can't become an issue`
						: `the task ID "${unstorable.id}" can't become an issue`,
					409,
				);
			}
			let ids = new Set(graph.definition.tasks.map(task => task.id));
			if (Object.keys(input.assignees).some(id => !ids.has(id))) {
				throw new GitHubError("the tasks have changed; reload and try again", 409);
			}
			let previous = plan.issues;
			let kept: Record<string, Entry> = {};
			for (let task of graph.definition.tasks) {
				let entry: Entry = { ...previous?.tasks[task.id] };
				delete entry.problem;
				// Only links to the task's current dependencies are kept, so a task revised across
				// versions never gathers more than it has.
				if (entry.blockedBy) {
					let current = entry.blockedBy.filter(id => task.dependsOn.includes(id));
					if (current.length > 0) entry.blockedBy = current;
					else delete entry.blockedBy;
				}
				if (Object.hasOwn(input.assignees, task.id) && !entry.assigned) {
					let assignee = input.assignees[task.id];
					if (assignee) entry.assignee = assignee;
					else delete entry.assignee;
				}
				kept[task.id] = entry;
			}
			// The press before this one, if it left anything unmade, joins those whose issues are
			// looked for: its presser and start, the earliest kept for each presser.
			let unresolved = [...previous?.unresolved ?? []];
			let unfinished = previous
				&& (!previous.parent
					|| graph.definition.tasks.some(task => !previous.tasks[task.id]?.issue));
			if (previous && unfinished) {
				let same = unresolved.findIndex(press => press.by === previous.by);
				if (same === -1) unresolved.push({ by: previous.by, at: previous.at });
				else if (previous.at < unresolved[same]!.at) {
					unresolved[same] = { by: previous.by, at: previous.at };
				}
			}
			unresolved = unresolved.slice(-MAX_UNRESOLVED);
			// Issues of tasks the graph no longer has wait to be closed; a task that came back before
			// its issue was closed takes it back.
			let removed = [...previous?.removed ?? []];
			for (let [id, entry] of Object.entries(previous?.tasks ?? {})) {
				if (
					!ids.has(id) && entry.issue && !removed.some(item => item.issue.id === entry.issue!.id)
				) {
					removed.push({ task: id, issue: entry.issue });
				}
			}
			removed = removed.filter(item => {
				let back = ids.has(item.task) ? kept[item.task] : undefined;
				if (!back) return true;
				if (!back.issue) back.issue = item.issue;
				return false;
			}).slice(-MAX_EXPORTED_TASKS);
			plan.issues = {
				...expected,
				by: input.by,
				at: new Date().toISOString(),
				...(unresolved.length > 0 ? { unresolved } : {}),
				...(removed.length > 0 ? { removed } : {}),
				...(previous?.parent ? { parent: previous.parent } : {}),
				tasks: kept,
			};
			try {
				await persistExclusive(plan);
			} catch (error) {
				if (previous) plan.issues = previous;
				else delete plan.issues;
				throw error;
			}
			announceImplementation(plan);
			return { tasks: graph.definition.tasks, records: [...plan.records.values()] };
		})
	);
	let state = () => context.withPlan(async plan => structuredClone(plan.issues!));
	let save = (change: (issues: IssueExport) => void) =>
		context.withPlan(plan => commit(plan, expected, change));

	let current = await state();
	let missing = !current.parent || tasks.some(task => !current.tasks[task.id]?.issue);
	// A press after one that left something unmade first finds, by marker, any issue an earlier
	// press made but could not record, among its own presser's issues, so it is never made twice.
	if (current.unresolved && missing) {
		let unresolved = current.unresolved;
		let found;
		try {
			found = await recover(context, tasks, current, unresolved);
		} catch (error) {
			let problem = RECOVERY_FAILED;
			await save(issues => void (issues.problem = problem));
			throw new GitHubError(problem, error instanceof GitHubError ? error.status : 502);
		}
		if (found.parent || found.tasks.size > 0) {
			await save(issues => {
				if (found.parent && !issues.parent) issues.parent = found.parent;
				for (let [id, issue] of found.tasks) {
					let saved = issues.tasks[id] ?? {};
					if (!saved.issue) issues.tasks[id] = { ...saved, issue };
				}
			});
			current = await state();
		}
	}
	let open = stillOpen(records).length > 0;
	let parent = current.parent;
	let madeParent = !parent;
	let made: number[] = [];
	if (!parent) {
		try {
			parent = await context.github.createIssue(
				parentIssue({
					title: context.title,
					url: context.url,
					channelId: context.channelId,
					records,
				}),
			);
		} catch (error) {
			let problem = problemFor(error, "create");
			await save(issues => void (issues.problem = problem));
			throw new GitHubError(problem, error instanceof GitHubError ? error.status : 502);
		}
		// A failure to save it ends the press; the next one finds the issue by its marker.
		let created = parent;
		await save(issues => {
			issues.parent = created;
			delete issues.problem;
		});
	}

	let ordered = dependencyOrder(tasks);
	let issueOf = new Map<string, GitHubIssueRef>();
	for (let task of ordered) {
		let entry = current.tasks[task.id];
		if (entry?.issue) {
			issueOf.set(task.id, entry.issue);
			continue;
		}
		let dependencies = task.dependsOn.flatMap(id => {
			let issue = issueOf.get(id);
			let title = tasks.find(item => item.id === id)?.title;
			return issue && title ? [{ number: issue.number, title }] : [];
		});
		let issue: GitHubIssueRef;
		try {
			issue = await context.github.createIssue(taskIssue({
				task,
				parent: parent.number,
				dependencies,
				title: context.title,
				url: context.url,
				channelId: context.channelId,
				open,
			}));
		} catch (error) {
			let problem = problemFor(error, "create");
			await save(issues => {
				issues.tasks[task.id] = { ...issues.tasks[task.id], problem };
			});
			continue;
		}
		// Only GitHub's refusal is the task's problem. A failure to save the issue ends the press
		// before anything is linked to it; the next press finds it by its marker.
		await save(issues => {
			let saved = issues.tasks[task.id] ?? {};
			saved.issue = issue;
			delete saved.problem;
			issues.tasks[task.id] = saved;
		});
		issueOf.set(task.id, issue);
		made.push(issue.number);
	}

	// Links, then blocked-by, then assignees: each recorded so a press again skips what is done.
	for (let task of ordered) {
		let issue = issueOf.get(task.id);
		if (!issue) continue;
		current = await state();
		let entry = current.tasks[task.id] ?? {};
		if (!entry.linked) {
			let linked = await step(
				() => context.github.addSubIssue(parent.number, issue.id),
				problem =>
					save(issues => {
						issues.tasks[task.id] = { ...issues.tasks[task.id], problem };
					}),
				"link",
			);
			if (linked) {
				await save(issues => {
					issues.tasks[task.id] = { ...issues.tasks[task.id], linked: true };
				});
			}
		}
		let blocked = new Set(entry.blockedBy ?? []);
		for (let id of task.dependsOn) {
			let blocker = issueOf.get(id);
			if (!blocker || blocked.has(id)) continue;
			let blockerId = blocker.id;
			let linked = await step(
				() => context.github.addBlockedBy(issue.number, blockerId),
				problem =>
					save(issues => {
						issues.tasks[task.id] = { ...issues.tasks[task.id], problem };
					}),
				"block",
			);
			if (!linked) continue;
			blocked.add(id);
			let done = [...blocked];
			await save(issues => {
				issues.tasks[task.id] = { ...issues.tasks[task.id], blockedBy: done };
			});
		}
		let assignee = entry.assignee;
		if (assignee && !entry.assigned && context.canAssign === false) {
			let problem = READ_ONLY_ISSUES;
			await save(issues => {
				issues.tasks[task.id] = { ...issues.tasks[task.id], problem };
			});
		} else if (assignee && !entry.assigned) {
			let copilot = assignee === COPILOT;
			let assigned = await step(
				async () => {
					let logins = await context.github.addAssignees(issue.number, {
						assignees: [copilot ? COPILOT_LOGIN : assignee],
						...(copilot
							? {
								agent: {
									repository: context.repository,
									...(context.defaultBranch ? { baseBranch: context.defaultBranch } : {}),
								},
							}
							: {}),
					});
					let took = logins.some(login =>
						copilot ? /copilot/i.test(login) : login.toLowerCase() === assignee.toLowerCase()
					);
					if (!took) {
						// GitHub answered without the assignee: it ignores logins it may not assign.
						throw new GitHubError(
							`assignee was not added (GitHub answered ${logins.length} assignees)`,
							422,
						);
					}
				},
				problem =>
					save(issues => {
						issues.tasks[task.id] = { ...issues.tasks[task.id], problem };
					}),
				"assign",
				error =>
					// Token-safe: the step, GitHub's status and our reason, never a token or a body.
					console.error(
						"chopin: assigning an exported issue failed",
						JSON.stringify({
							issue: issue.number,
							copilot,
							status: error instanceof GitHubError ? error.status : undefined,
							reason: error instanceof Error ? error.message : String(error),
						}),
					),
			);
			if (assigned) {
				await save(issues => {
					issues.tasks[task.id] = { ...issues.tasks[task.id], assigned: true };
				});
			}
		}
	}
	// Close the issues of tasks removed from the graph, each as GitHub confirms it.
	let closed = 0;
	let closeIssue = context.github.closeIssue;
	if (closeIssue) {
		for (let item of (await state()).removed ?? []) {
			let done = await step(
				() => closeIssue(item.issue.number),
				problem => save(issues => void (issues.problem = problem)),
				"close",
			);
			if (!done) continue;
			closed++;
			await save(issues => {
				let left = (issues.removed ?? []).filter(other => other.issue.id !== item.issue.id);
				if (left.length > 0) issues.removed = left;
				else delete issues.removed;
			});
		}
	}

	// Every issue recorded: no earlier press's issues need looking for any more.
	let finished = await state();
	if (
		finished.unresolved && finished.parent
		&& tasks.every(task => finished.tasks[task.id]?.issue)
	) {
		await save(issues => void delete issues.unresolved);
	}
	if (madeParent || made.length > 0 || closed > 0) {
		let link = `[#${parent.number}](${parent.url})`;
		let count = `${made.length} ${made.length === 1 ? "issue" : "issues"}`;
		let closing = closed > 0
			? `closed ${closed} ${closed === 1 ? "issue" : "issues"} of tasks removed from the document`
			: "";
		let text = madeParent
			? `@${input.by} made this document’s tasks into ${link} with ${count} under it.`
			: made.length > 0
			? `@${input.by} added ${count} under ${link}${closing ? ` and ${closing}` : ""}.`
			: `@${input.by} ${closing} under ${link}.`;
		let notice = {
			id: `issues:${parent.number}:${madeParent ? "parent" : ""}:${made.join(",")}${
				closed > 0 ? `:closed:${closed}` : ""
			}`,
			text,
		};
		// Only scheduled here: Chat's line takes the document lock once this action lets it go.
		await context.withPlan(async plan => plan.persistence.onBuildNotice?.(plan.id, notice));
	}
	return state();
}
