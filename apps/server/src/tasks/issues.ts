/**
 * Exporting an implementation graph as GitHub issues: one parent issue for the document, a
 * sub-issue per task, "blocked by" links from the tasks' dependencies, and the assignee a writer
 * picked. The server creates them with the presser's GitHub App user token; the Planner never does.
 *
 * GitHub is written first and the result committed after each step, so a step that failed, or a
 * process that stopped, is resumed by pressing again: an issue Chopin recorded is never created
 * twice. An answer lost after GitHub created an issue can still leave a duplicate; every body
 * carries a hidden marker naming its document and task to find it by.
 */
import { z } from "zod";
import { GitHubError } from "../github/client";
import { exclusive, persistExclusive } from "../plan/service";
import { announceImplementation } from "./notifications";
import { unapprovedDecisions } from "./open-decisions";

import type { GitHubAssignment, GitHubIssueRef } from "../github/client";
import type { Plan } from "../plan/service";
import type { Record as DecisionRecord } from "../questions/records";
import type { Task, Version } from "./graphs";
import type { IssueExportSnapshot } from "@chopin/protocol/implementation";

/** The assignee value that asks for Copilot's coding agent rather than a person. */
export const COPILOT = "copilot";
const COPILOT_LOGIN = "copilot-swe-agent[bot]";
/** GitHub caps an issue body at 65,536 characters. */
const MAX_BODY = 60_000;
const MAX_FIELD = 12_000;
export const MAX_EXPORTED_TASKS = 100;

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
	parent: refSchema.optional(),
	problem: z.string().min(1).max(300).optional(),
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
		"",
		`<!-- chopin:${input.channelId} -->`,
	].join("\n");
	return { title: clip(input.title, 250) || "Implementation tasks", body: clip(body, MAX_BODY) };
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
		"",
		`<!-- chopin:${input.channelId}:${task.id} -->`,
	].join("\n");
	return { title: clip(task.title, 250), body: clip(body, MAX_BODY) };
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

/** A failed GitHub step in plain words. */
export function problemFor(error: unknown, step: "create" | "link" | "block" | "assign"): string {
	let status = error instanceof GitHubError ? error.status : undefined;
	if (status === 429) return "GitHub's rate limit was reached. Try again in a few minutes.";
	if (status === 410) return "Issues are turned off for this repository.";
	if (step === "assign") {
		return "Couldn't assign this issue. Check that the person can be assigned here, or that Copilot coding agent is enabled for the repository.";
	}
	if (status === 401 || status === 403 || status === 404) {
		return "Chopin's GitHub App can't write issues here. Give it Issues: Read and write, then try again.";
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
};

export type ExportContext = {
	channelId: string;
	title: string;
	url: string;
	/** `owner/name`, for Copilot's assignment. */
	repository: string;
	defaultBranch?: string;
	/** Runs `action` with the room locked, as the routes' `withPlan` does. */
	withPlan<T>(action: (plan: Plan) => Promise<T>): Promise<T>;
	github: IssueWriter;
};

/** Channels with an export under way in this process; a second press waits for the first. */
let running = new Set<string>();

export function exporting(channelId: string): boolean {
	return running.has(channelId);
}

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
	if (running.has(context.channelId)) {
		throw new GitHubError("issues are already being created for this document", 409);
	}
	running.add(context.channelId);
	try {
		return await run(context, input);
	} finally {
		running.delete(context.channelId);
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
			if (graph.definition.tasks.length > MAX_EXPORTED_TASKS) {
				throw new GitHubError(`at most ${MAX_EXPORTED_TASKS} tasks can become issues`, 409);
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
				if (Object.hasOwn(input.assignees, task.id) && !entry.assigned) {
					let assignee = input.assignees[task.id];
					if (assignee) entry.assignee = assignee;
					else delete entry.assignee;
				}
				kept[task.id] = entry;
			}
			plan.issues = {
				...expected,
				by: input.by,
				at: new Date().toISOString(),
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
		try {
			let issue = await context.github.createIssue(taskIssue({
				task,
				parent: parent.number,
				dependencies,
				title: context.title,
				url: context.url,
				channelId: context.channelId,
				open,
			}));
			issueOf.set(task.id, issue);
			made.push(issue.number);
			await save(issues => {
				let saved = issues.tasks[task.id] ?? {};
				saved.issue = issue;
				delete saved.problem;
				issues.tasks[task.id] = saved;
			});
		} catch (error) {
			if (error instanceof GitHubError && error.status === 409) throw error;
			let problem = problemFor(error, "create");
			await save(issues => {
				issues.tasks[task.id] = { ...issues.tasks[task.id], problem };
			});
		}
	}

	// Links, then blocked-by, then assignees: each recorded so a press again skips what is done.
	for (let task of ordered) {
		let issue = issueOf.get(task.id);
		if (!issue) continue;
		current = await state();
		let entry = current.tasks[task.id] ?? {};
		if (!entry.linked) {
			try {
				await context.github.addSubIssue(parent.number, issue.id);
				await save(issues => {
					issues.tasks[task.id] = { ...issues.tasks[task.id], linked: true };
				});
			} catch (error) {
				if (error instanceof GitHubError && error.status === 409) throw error;
				let problem = problemFor(error, "link");
				await save(issues => {
					issues.tasks[task.id] = { ...issues.tasks[task.id], problem };
				});
			}
		}
		let blocked = new Set(entry.blockedBy ?? []);
		for (let id of task.dependsOn) {
			let blocker = issueOf.get(id);
			if (!blocker || blocked.has(id)) continue;
			try {
				await context.github.addBlockedBy(issue.number, blocker.id);
				blocked.add(id);
				let done = [...blocked];
				await save(issues => {
					issues.tasks[task.id] = { ...issues.tasks[task.id], blockedBy: done };
				});
			} catch (error) {
				if (error instanceof GitHubError && error.status === 409) throw error;
				let problem = problemFor(error, "block");
				await save(issues => {
					issues.tasks[task.id] = { ...issues.tasks[task.id], problem };
				});
			}
		}
		let assignee = entry.assignee;
		if (assignee && !entry.assigned) {
			let copilot = assignee === COPILOT;
			try {
				let assigned = await context.github.addAssignees(issue.number, {
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
				let took = assigned.some(login =>
					copilot ? /copilot/i.test(login) : login.toLowerCase() === assignee.toLowerCase()
				);
				if (!took) {
					// GitHub answered without the assignee: it ignores logins it may not assign.
					throw new GitHubError(
						`assignee was not added (GitHub answered ${assigned.length} assignees)`,
						422,
					);
				}
				await save(issues => {
					issues.tasks[task.id] = { ...issues.tasks[task.id], assigned: true };
				});
			} catch (error) {
				if (error instanceof GitHubError && error.status === 409) throw error;
				// Token-safe: the step, GitHub's status and our reason, never a token or a body.
				console.error(
					"chopin: assigning an exported issue failed",
					JSON.stringify({
						issue: issue.number,
						copilot,
						status: error instanceof GitHubError ? error.status : undefined,
						reason: error instanceof Error ? error.message : String(error),
					}),
				);
				let problem = problemFor(error, "assign");
				await save(issues => {
					issues.tasks[task.id] = { ...issues.tasks[task.id], problem };
				});
			}
		}
	}
	if (madeParent || made.length > 0) {
		let link = `[#${parent.number}](${parent.url})`;
		let count = `${made.length} ${made.length === 1 ? "issue" : "issues"}`;
		let notice = {
			id: `issues:${parent.number}:${madeParent ? "parent" : ""}:${made.join(",")}`,
			text: madeParent
				? `@${input.by} made this document’s tasks into ${link} with ${count} under it.`
				: `@${input.by} added ${count} under ${link}.`,
		};
		// Only scheduled here: Chat's line takes the document lock once this action lets it go.
		await context.withPlan(async plan => plan.persistence.onBuildNotice?.(plan.id, notice));
	}
	return state();
}
