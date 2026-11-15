import { describe, expect, test } from "bun:test";
import { GitHubError } from "../github/client";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";
import { implementationGraphs } from "./plan-graphs";
import {
	COPILOT,
	dependencyOrder,
	exportIssues,
	issueLinks,
	issuesSnapshot,
	parentIssue,
	READ_ONLY_ISSUES,
	restoreIssues,
	taskIssue,
} from "./issues";

import type { GitHubAssignment } from "../github/client";
import type { Task } from "./graphs";
import type { ExportContext } from "./issues";

let tasks: Task[] = [
	{
		id: "api",
		title: "Expose the export endpoint",
		context: "The export needs an endpoint.",
		goal: "POST /export answers a file.",
		acceptance: ["Answers 200 with a file", "Refuses readers"],
		dependsOn: ["model"],
	},
	{
		id: "model",
		title: "Model the export",
		context: "The document needs an export shape.",
		goal: "An Export type exists.",
		acceptance: ["Type checks", "Has a format field"],
		dependsOn: [],
	},
	{
		id: "ui",
		title: "Add the export button",
		context: "People need a button.",
		goal: "The header shows Export.",
		acceptance: ["Export appears for writers", "Hidden for readers"],
		dependsOn: ["api", "model"],
	},
];

type Call =
	| { kind: "create"; title: string; body: string }
	| { kind: "link"; parent: number; child: number }
	| { kind: "block"; issue: number; blocker: number }
	| { kind: "assign"; issue: number; assignment: GitHubAssignment };

function fakeGitHub(fail: (call: Call) => GitHubError | undefined = () => undefined) {
	let calls: Call[] = [];
	let next = 1;
	let record = (call: Call) => {
		let error = fail(call);
		if (error) throw error;
		calls.push(call);
	};
	return {
		calls,
		github: {
			async createIssue(input: { title: string; body: string }) {
				record({ kind: "create", ...input });
				let number = next++;
				return {
					id: 1000 + number,
					number,
					url: `https://github.com/owner/repository/issues/${number}`,
				};
			},
			async addSubIssue(parent: number, child: number) {
				record({ kind: "link", parent, child });
			},
			async addBlockedBy(issue: number, blocker: number) {
				record({ kind: "block", issue, blocker });
			},
			async addAssignees(issue: number, assignment: GitHubAssignment) {
				record({ kind: "assign", issue, assignment });
				return assignment.assignees.map(login =>
					login === "copilot-swe-agent[bot]" ? "Copilot" : login
				);
			},
		},
	};
}

async function drafted() {
	let context = await openPlan("# Export\n");
	// A task can only depend on one added before it.
	let saved = await implementationGraphs().revise(context.plan, {
		planRevision: 0,
		graphRevision: 0,
		operations: [tasks[1]!, tasks[0]!, tasks[2]!].map(task => ({ op: "add" as const, task })),
	});
	if (!saved.ok) throw new Error(`graph refused: ${saved.reason}`);
	let graph = context.plan.graph!.versions.at(-1)!;
	let exportContext = (github: ExportContext["github"]): ExportContext => ({
		channelId: context.plan.id,
		title: "Export",
		url: "https://chopin.test/owner/repository/export",
		repository: "owner/repository",
		defaultBranch: "main",
		withPlan: action => action(context.plan),
		github,
	});
	let input = (assignees: Record<string, string | null> = {}) => ({
		graphNumber: graph.number,
		graphRevision: graph.revision,
		by: "test",
		assignees,
	});
	return { context, exportContext, input };
}

describe("issue bodies", () => {
	test("orders tasks after their dependencies and keeps the graph's order otherwise", () => {
		expect(dependencyOrder(tasks).map(task => task.id)).toEqual(["model", "api", "ui"]);
	});

	test("a task issue carries context, goal, an acceptance checklist, dependencies and a marker", () => {
		let { title, body } = taskIssue({
			task: tasks[0]!,
			parent: 7,
			dependencies: [{ number: 8, title: "Model the export" }],
			title: "Export",
			url: "https://chopin.test/doc",
			channelId: "C1",
			open: true,
		});
		expect(title).toBe("Expose the export endpoint");
		expect(body).toContain("The export needs an endpoint.");
		expect(body).toContain("## Goal\n\nPOST /export answers a file.");
		expect(body).toContain("- [ ] Answers 200 with a file\n- [ ] Refuses readers");
		expect(body).toContain("## Depends on\n\n- #8");
		expect(body).toContain("Part of #7, from [Export](https://chopin.test/doc) in Chopin.");
		expect(body).toContain("Some decisions are still open; see #7.");
		expect(body).toContain("<!-- chopin:C1:api -->");
	});

	test("the parent lists answered decisions with their why, and those still open", () => {
		let { body } = parentIssue({
			title: "Export",
			url: "https://chopin.test/doc",
			channelId: "C1",
			records: [
				{
					id: "d1",
					status: "answered",
					choices: ["csv"],
					why: "Spreadsheets open it.",
					definition: {
						questions: [{
							id: "q1",
							question: "Which format?",
							options: [{ id: "csv", label: "CSV" }, { id: "json", label: "JSON" }],
						}],
					},
				},
				{
					id: "d2",
					status: "open",
					definition: {
						questions: [{
							id: "q2",
							question: "Who can export?",
							options: [{ id: "all", label: "Everyone" }, { id: "writers", label: "Writers" }],
						}],
					},
				},
			] as never,
		});
		expect(body).toContain("## Decided\n\n- **Which format?** CSV\n  - Why: Spreadsheets open it.");
		expect(body).toContain("## Still open");
		expect(body).toContain("- Who can export? (Everyone, Writers)");
		expect(body).toContain("<!-- chopin:C1 -->");
	});
});

describe("exportIssues", () => {
	test("creates the parent, then tasks in dependency order, links, blocked-by and assignees", async () => {
		let { context, exportContext, input } = await drafted();
		let notices: Array<{ id: string; text: string }> = [];
		context.plan.persistence.onBuildNotice = (_id, notice) => notices.push(notice);
		try {
			let { calls, github } = fakeGitHub();
			let result = await exportIssues(exportContext(github), input({ model: "ana", ui: COPILOT }));
			expect(calls.filter(call => call.kind === "create").map(call => call.title)).toEqual([
				"Export",
				"Model the export",
				"Expose the export endpoint",
				"Add the export button",
			]);
			// Parent #1, model #2, api #3, ui #4; ids are 1000 + number.
			expect(calls.filter(call => call.kind === "link")).toEqual([
				{ kind: "link", parent: 1, child: 1002 },
				{ kind: "link", parent: 1, child: 1003 },
				{ kind: "link", parent: 1, child: 1004 },
			]);
			expect(calls.filter(call => call.kind === "block")).toEqual([
				{ kind: "block", issue: 3, blocker: 1002 },
				{ kind: "block", issue: 4, blocker: 1003 },
				{ kind: "block", issue: 4, blocker: 1002 },
			]);
			expect(calls.filter(call => call.kind === "assign")).toEqual([
				{ kind: "assign", issue: 2, assignment: { assignees: ["ana"] } },
				{
					kind: "assign",
					issue: 4,
					assignment: {
						assignees: ["copilot-swe-agent[bot]"],
						agent: { repository: "owner/repository", baseBranch: "main" },
					},
				},
			]);
			let body = calls.find(call =>
				call.kind === "create" && call.title === "Expose the export endpoint"
			);
			expect(body && "body" in body && body.body).toContain("- #2");
			expect(result.parent).toMatchObject({ number: 1 });
			expect(result.tasks.ui).toMatchObject({
				issue: { number: 4 },
				assignee: COPILOT,
				assigned: true,
			});
			expect(issuesSnapshot(context.plan, false)).toMatchObject({
				by: "test",
				current: true,
				running: false,
				parent: { number: 1 },
				tasks: { model: { number: 2, assignee: "ana", assigned: true }, api: { number: 3 } },
			});
			// Every step was committed and announced.
			expect(context.broadcasts.some(frame => frame.kind === "plan:implementation")).toBe(true);
			expect(notices).toEqual([{
				id: "issues:1:parent:2,3,4",
				text:
					"@test made this document’s tasks into [#1](https://github.com/owner/repository/issues/1) with 3 issues under it.",
			}]);
		} finally {
			await Service.close(context.plan);
		}
	});

	test("pressing again after a failure creates only what is missing", async () => {
		let { context, exportContext, input } = await drafted();
		let notices: Array<{ id: string; text: string }> = [];
		context.plan.persistence.onBuildNotice = (_id, notice) => notices.push(notice);
		try {
			let failing = true;
			let first = fakeGitHub(call =>
				failing && call.kind === "create" && call.title === "Expose the export endpoint"
					? new GitHubError("GitHub API rejected the request", 502)
					: undefined
			);
			let result = await exportIssues(exportContext(first.github), input());
			expect(result.tasks.api).toMatchObject({ problem: "GitHub couldn't be reached. Try again." });
			expect(result.tasks.api?.issue).toBeUndefined();
			// The ui issue could not name the api issue it waits on, so only model blocks it.
			expect(first.calls.filter(call => call.kind === "block")).toEqual([
				{ kind: "block", issue: 3, blocker: 1002 },
			]);

			failing = false;
			let second = fakeGitHub();
			let again = await exportIssues(exportContext(second.github), input());
			expect(second.calls.filter(call => call.kind === "create").map(call => call.title)).toEqual([
				"Expose the export endpoint",
			]);
			expect(again.tasks.api).toMatchObject({ issue: { number: 1 }, linked: true });
			expect(again.tasks.api?.problem).toBeUndefined();
			expect(second.calls.filter(call => call.kind === "block")).toEqual([
				{ kind: "block", issue: 1, blocker: 1002 },
				{ kind: "block", issue: 3, blocker: 1001 },
			]);

			let third = fakeGitHub();
			await exportIssues(exportContext(third.github), input());
			expect(third.calls).toEqual([]);
			// The second press said what it added; the third added nothing and said nothing.
			expect(notices.map(notice => notice.text)).toEqual([
				"@test made this document’s tasks into [#1](https://github.com/owner/repository/issues/1) with 2 issues under it.",
				"@test added 1 issue under [#1](https://github.com/owner/repository/issues/1).",
			]);
		} finally {
			await Service.close(context.plan);
		}
	});

	test("a refused assignee is reported on its task and the rest still go ahead", async () => {
		let { context, exportContext, input } = await drafted();
		try {
			let { github } = fakeGitHub();
			let result = await exportIssues(
				exportContext({ ...github, addAssignees: async () => [] }),
				input({ model: "nobody" }),
			);
			expect(result.tasks.model).toMatchObject({ issue: { number: 2 }, assignee: "nobody" });
			expect(result.tasks.model?.assigned).toBeUndefined();
			expect(result.tasks.model?.problem).toContain("Couldn't assign this issue");
			expect(result.tasks.ui?.issue).toBeDefined();
		} finally {
			await Service.close(context.plan);
		}
	});

	test("with read-only Issues it still makes and links the issues, and says why it didn't assign", async () => {
		let { context, exportContext, input } = await drafted();
		try {
			let { calls, github } = fakeGitHub();
			let result = await exportIssues(
				{ ...exportContext(github), canAssign: false },
				input({ model: "ana" }),
			);
			expect(calls.filter(call => call.kind === "create")).toHaveLength(4);
			expect(calls.filter(call => call.kind === "assign")).toEqual([]);
			expect(result.tasks.model).toMatchObject({ assignee: "ana", problem: READ_ONLY_ISSUES });
			expect(result.tasks.model?.assigned).toBeUndefined();
			expect(result.tasks.api?.problem).toBeUndefined();
		} finally {
			await Service.close(context.plan);
		}
	});

	test("hands the coding agent each task's issue so its pull request closes it", async () => {
		let { context, exportContext, input } = await drafted();
		try {
			expect(issueLinks(context.plan)).toEqual({});
			let { github } = fakeGitHub();
			await exportIssues(exportContext(github), input());
			let links = issueLinks(context.plan).issues!;
			expect(links.parent).toEqual({
				number: 1,
				url: "https://github.com/owner/repository/issues/1",
			});
			expect(links.tasks).toEqual({
				model: { number: 2, url: "https://github.com/owner/repository/issues/2" },
				api: { number: 3, url: "https://github.com/owner/repository/issues/3" },
				ui: { number: 4, url: "https://github.com/owner/repository/issues/4" },
			});
			expect(links.instructions).toContain("Closes #<number>");
		} finally {
			await Service.close(context.plan);
		}
	});

	test("a parent the App may not create stops the export with a reason", async () => {
		let { context, exportContext, input } = await drafted();
		try {
			let { github, calls } = fakeGitHub(() =>
				new GitHubError("GitHub API rejected the request", 403)
			);
			await expect(exportIssues(exportContext(github), input())).rejects.toThrow(
				"Chopin's GitHub App can't write issues here",
			);
			expect(calls).toEqual([]);
			expect(context.plan.issues?.problem).toContain("Issues: Read and write");
		} finally {
			await Service.close(context.plan);
		}
	});

	test("refuses a graph version that is no longer the latest, and a second press while one runs", async () => {
		let { context, exportContext, input } = await drafted();
		try {
			let { github } = fakeGitHub();
			await expect(exportIssues(exportContext(github), { ...input(), graphRevision: 99 })).rejects
				.toMatchObject({ status: 409 });
			let release!: () => void;
			let gate = new Promise<void>(resolve => (release = resolve));
			let slow = exportIssues(
				exportContext({
					...github,
					createIssue: async issue => {
						await gate;
						return github.createIssue(issue);
					},
				}),
				input(),
			);
			await expect(exportIssues(exportContext(github), input())).rejects.toMatchObject({
				status: 409,
			});
			expect(issuesSnapshot(context.plan, true)?.running).toBe(true);
			release();
			await slow;
		} finally {
			await Service.close(context.plan);
		}
	});

	test("an intent that fails to persist leaves the document without an export", async () => {
		let { context, exportContext, input } = await drafted();
		try {
			let commit = context.storage.collaboration.commit;
			context.storage.collaboration.commit = async () => {
				throw new Error("offline");
			};
			let { github, calls } = fakeGitHub();
			await expect(exportIssues(exportContext(github), input())).rejects.toThrow("offline");
			context.storage.collaboration.commit = commit;
			expect(context.plan.issues).toBeUndefined();
			expect(calls).toEqual([]);
		} finally {
			await Service.close(context.plan);
		}
	});

	test("the export survives a reopen, and an invalid stored export rejects the document", async () => {
		let { context, exportContext, input } = await drafted();
		let { github } = fakeGitHub();
		await exportIssues(exportContext(github), input());
		let stored = structuredClone(context.plan.issues);
		await Service.close(context.plan);
		let reopened = await Service.open(context.channel.id, context.backend, context.server);
		try {
			expect(reopened.issues).toEqual(stored!);
		} finally {
			await Service.close(reopened);
		}
		expect(() => restoreIssues({ ...stored, unknown: true })).toThrow();
		expect(() =>
			restoreIssues({ ...stored, tasks: { api: { issue: { id: 1, number: 0, url: "x" } } } })
		)
			.toThrow();
	});
});
