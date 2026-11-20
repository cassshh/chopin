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
	MAX_PENDING_CLOSES,
	parentIssue,
	READ_ONLY_ISSUES,
	RECOVERY_FAILED,
	restoreIssues,
	taskIssue,
	taskMarker,
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

	test("an issue whose creation answer was lost is found by its marker, not made again", async () => {
		let { context, exportContext, input } = await drafted();
		try {
			// GitHub makes the api issue, but its answer never arrives.
			let made: Array<{ id: number; number: number; url: string; body: string }> = [];
			let first = fakeGitHub();
			let create = first.github.createIssue;
			first.github.createIssue = async issue => {
				let ref = await create(issue);
				made.push({ ...ref, body: issue.body });
				if (issue.title === "Expose the export endpoint") {
					throw new GitHubError("GitHub API rejected the request", 502);
				}
				return ref;
			};
			let result = await exportIssues(exportContext(first.github), input());
			expect(result.tasks.api?.issue).toBeUndefined();

			let second = fakeGitHub();
			let since: string[] = [];
			let again = await exportIssues(
				exportContext({
					...second.github,
					issuesBy: async (_creator, from) => {
						since.push(from);
						return made;
					},
				}),
				input(),
			);
			// Nothing was made again: the lost issue is recorded, then linked and blocked as usual.
			expect(second.calls.filter(call => call.kind === "create")).toEqual([]);
			let lost = made.find(issue => issue.body.endsWith(taskMarker(context.plan.id, "api")))!;
			expect(again.tasks.api).toMatchObject({ issue: { number: lost.number }, linked: true });
			expect(second.calls).toContainEqual({ kind: "link", parent: 1, child: lost.id });
			// It looked from a minute before the first press.
			expect(Date.parse(since[0]!)).toBeLessThanOrEqual(Date.parse(result.at) - 60_000);
		} finally {
			await Service.close(context.plan);
		}
	});

	test("an issue that can't be saved ends the press before anything is linked to it", async () => {
		let { context, exportContext, input } = await drafted();
		try {
			let commit = context.storage.collaboration.commit;
			let { github, calls } = fakeGitHub();
			let create = github.createIssue;
			github.createIssue = async issue => {
				let ref = await create(issue);
				if (issue.title === "Model the export") {
					context.storage.collaboration.commit = async () => {
						throw new Error("offline");
					};
				}
				return ref;
			};
			await expect(exportIssues(exportContext(github), input())).rejects.toThrow("offline");
			context.storage.collaboration.commit = commit;
			// The unsaved model issue was never linked, and no later task was made.
			expect(calls.filter(call => call.kind !== "create")).toEqual([]);
			expect(calls.filter(call => call.kind === "create")).toHaveLength(2);
			expect(context.plan.issues?.tasks.model?.issue).toBeUndefined();
		} finally {
			await Service.close(context.plan);
		}
	});

	test("an issue another person's press made but never recorded is found among their issues", async () => {
		let { context, exportContext, input } = await drafted();
		try {
			let made: Array<{ id: number; number: number; url: string; body: string }> = [];
			let first = fakeGitHub();
			let create = first.github.createIssue;
			first.github.createIssue = async issue => {
				let ref = await create(issue);
				made.push({ ...ref, body: issue.body });
				if (issue.title === "Expose the export endpoint") {
					throw new GitHubError("GitHub API rejected the request", 502);
				}
				return ref;
			};
			// ana pressed first; bea presses again, then cy, and only ana's issues hold the lost one.
			let firstPress = await exportIssues(exportContext(first.github), { ...input(), by: "ana" });
			let asked: Array<[string, string]> = [];
			let lister = (github: ExportContext["github"]) => ({
				...github,
				issuesBy: async (creator: string, since: string) => {
					asked.push([creator, since]);
					return creator === "ana" ? made : [];
				},
			});
			// bea's press can neither list issues nor make the api issue, so it stays unmade for cy.
			let failing = fakeGitHub(call =>
				call.kind === "create" && call.title === "Expose the export endpoint"
					? new GitHubError("GitHub API rejected the request", 502)
					: undefined
			);
			await exportIssues(exportContext(failing.github), { ...input(), by: "bea" });
			expect(context.plan.issues?.unresolved).toEqual([{ by: "ana", at: firstPress.at }]);

			let third = fakeGitHub();
			let again = await exportIssues(exportContext(lister(third.github)), { ...input(), by: "cy" });
			expect(asked.map(([creator]) => creator).sort()).toEqual(["ana", "bea"]);
			expect(third.calls.filter(call => call.kind === "create")).toEqual([]);
			expect(again.tasks.api?.issue?.number).toBe(
				made.find(issue => issue.body.endsWith(taskMarker(context.plan.id, "api")))!.number,
			);
			// Everything is recorded now, so nobody's issues need looking for again.
			expect(again.unresolved).toBeUndefined();
		} finally {
			await Service.close(context.plan);
		}
	});

	test("a recovery listing that fails ends the press without making anything", async () => {
		let { context, exportContext, input } = await drafted();
		try {
			let first = fakeGitHub(call =>
				call.kind === "create" && call.title === "Expose the export endpoint"
					? new GitHubError("GitHub API rejected the request", 502)
					: undefined
			);
			await exportIssues(exportContext(first.github), input());
			let second = fakeGitHub();
			await expect(exportIssues(
				exportContext({
					...second.github,
					issuesBy: async () => {
						throw new GitHubError("GitHub API rejected the request", 502);
					},
				}),
				input(),
			)).rejects.toThrow(RECOVERY_FAILED);
			expect(second.calls).toEqual([]);
			expect(context.plan.issues?.problem).toBe(RECOVERY_FAILED);
			expect(context.plan.issues?.tasks.api?.issue).toBeUndefined();
		} finally {
			await Service.close(context.plan);
		}
	});

	test("issues are refused while a build of the tasks is under way", async () => {
		let { context, exportContext, input } = await drafted();
		try {
			context.plan.claiming = true;
			let { github, calls } = fakeGitHub();
			await expect(exportIssues(exportContext(github), input())).rejects.toThrow(
				"a build of these tasks is under way",
			);
			expect(context.plan.issues).toBeUndefined();
			expect(calls).toEqual([]);
		} finally {
			context.plan.claiming = false;
			await Service.close(context.plan);
		}
	});

	test("a revised task keeps only the blocked-by links of its current dependencies", async () => {
		let { context, exportContext, input } = await drafted();
		try {
			await exportIssues(exportContext(fakeGitHub().github), input());
			expect(context.plan.issues?.tasks.ui?.blockedBy?.sort()).toEqual(["api", "model"]);
			let graph = context.plan.graph!.versions.at(-1)!;
			let revised = await implementationGraphs().revise(context.plan, {
				planRevision: 0,
				graphRevision: graph.revision,
				operations: [{ op: "replace", id: "ui", task: { ...tasks[2]!, dependsOn: ["model"] } }],
			});
			if (!revised.ok) throw new Error(`graph refused: ${revised.reason}`);
			let next = context.plan.graph!.versions.at(-1)!;
			await exportIssues(exportContext(fakeGitHub().github), {
				...input(),
				graphNumber: next.number,
				graphRevision: next.revision,
			});
			expect(context.plan.issues?.tasks.ui?.blockedBy).toEqual(["model"]);
		} finally {
			await Service.close(context.plan);
		}
	});

	test("the issue of a task removed from the graph is closed as not planned, and kept until it is", async () => {
		let { context, exportContext, input } = await drafted();
		let notices: Array<{ id: string; text: string }> = [];
		context.plan.persistence.onBuildNotice = (_id, notice) => notices.push(notice);
		try {
			let first = await exportIssues(exportContext(fakeGitHub().github), input());
			let ui = first.tasks.ui!.issue!;
			let graph = context.plan.graph!.versions.at(-1)!;
			let revised = await implementationGraphs().revise(context.plan, {
				planRevision: 0,
				graphRevision: graph.revision,
				operations: [{ op: "remove", id: "ui" }],
			});
			if (!revised.ok) throw new Error(`graph refused: ${revised.reason}`);
			let next = () => {
				let version = context.plan.graph!.versions.at(-1)!;
				return { ...input(), graphNumber: version.number, graphRevision: version.revision };
			};

			// GitHub refuses the close: the issue waits, with the reason on the export.
			let closes: number[] = [];
			let refusing = fakeGitHub();
			let failed = await exportIssues(
				exportContext({
					...refusing.github,
					closeIssue: async () => {
						throw new GitHubError("GitHub API rejected the request", 502);
					},
				}),
				next(),
			);
			expect(failed.tasks.ui).toBeUndefined();
			expect(failed.removed).toEqual([{ task: "ui", issue: ui }]);
			expect(failed.problem).toBe("GitHub couldn't be reached. Try again.");

			// The next press closes it, says so in Chat, and forgets it.
			let closing = fakeGitHub();
			let done = await exportIssues(
				exportContext({ ...closing.github, closeIssue: async issue => void closes.push(issue) }),
				next(),
			);
			expect(closes).toEqual([ui.number]);
			expect(done.removed).toBeUndefined();
			expect(closing.calls.filter(call => call.kind === "create")).toEqual([]);
			expect(notices.at(-1)?.text).toBe(
				"@test closed 1 issue of tasks removed from the document under [#1](https://github.com/owner/repository/issues/1).",
			);
		} finally {
			await Service.close(context.plan);
		}
	});

	test("a press that would leave more issues waiting to close than are kept is refused, and drops none", async () => {
		let { context, exportContext, input } = await drafted();
		try {
			await exportIssues(exportContext(fakeGitHub().github), input());
			let graph = context.plan.graph!.versions.at(-1)!;
			let revised = await implementationGraphs().revise(context.plan, {
				planRevision: 0,
				graphRevision: graph.revision,
				operations: [{ op: "remove", id: "ui" }],
			});
			if (!revised.ok) throw new Error(`graph refused: ${revised.reason}`);
			// Earlier closes all failed: as many issues already wait as an export keeps.
			let waiting = Array.from({ length: MAX_PENDING_CLOSES }, (_, index) => ({
				task: `gone-${index}`,
				issue: {
					id: 10_000 + index,
					number: 1_000 + index,
					url: `https://github.com/owner/repository/issues/${1_000 + index}`,
				},
			}));
			context.plan.issues = { ...context.plan.issues!, removed: waiting };
			let before = structuredClone(context.plan.issues);
			let version = context.plan.graph!.versions.at(-1)!;
			let github = fakeGitHub();
			await expect(exportIssues(exportContext(github.github), {
				...input(),
				graphNumber: version.number,
				graphRevision: version.revision,
			})).rejects.toThrow("still waiting to be closed");
			expect(context.plan.issues).toEqual(before);
			expect(github.calls).toEqual([]);
		} finally {
			await Service.close(context.plan);
		}
	});

	test("a removed task that comes back before its issue is closed takes the issue back", async () => {
		let { context, exportContext, input } = await drafted();
		try {
			let first = await exportIssues(exportContext(fakeGitHub().github), input());
			let ui = first.tasks.ui!.issue!;
			let graph = context.plan.graph!.versions.at(-1)!;
			let removed = await implementationGraphs().revise(context.plan, {
				planRevision: 0,
				graphRevision: graph.revision,
				operations: [{ op: "remove", id: "ui" }],
			});
			if (!removed.ok) throw new Error(`graph refused: ${removed.reason}`);
			let version = context.plan.graph!.versions.at(-1)!;
			// No close is possible here, so the issue waits in `removed`.
			await exportIssues(exportContext(fakeGitHub().github), {
				...input(),
				graphNumber: version.number,
				graphRevision: version.revision,
			});
			expect(context.plan.issues?.removed).toEqual([{ task: "ui", issue: ui }]);
			let back = await implementationGraphs().revise(context.plan, {
				planRevision: 0,
				graphRevision: version.revision,
				operations: [{ op: "add", task: tasks[2]! }],
			});
			if (!back.ok) throw new Error(`graph refused: ${back.reason}`);
			let latest = context.plan.graph!.versions.at(-1)!;
			let again = fakeGitHub();
			let result = await exportIssues(exportContext(again.github), {
				...input(),
				graphNumber: latest.number,
				graphRevision: latest.revision,
			});
			expect(result.tasks.ui?.issue).toEqual(ui);
			expect(result.removed).toBeUndefined();
			expect(again.calls.filter(call => call.kind === "create")).toEqual([]);
		} finally {
			await Service.close(context.plan);
		}
	});

	test("a task ID that can't be an ordinary key is refused before anything is kept", async () => {
		let context = await openPlan("# Export\n");
		try {
			let saved = await implementationGraphs().revise(context.plan, {
				planRevision: 0,
				graphRevision: 0,
				operations: [{ op: "add", task: { ...tasks[1]!, id: "__proto__" } }],
			});
			if (!saved.ok) throw new Error(`graph refused: ${saved.reason}`);
			let graph = context.plan.graph!.versions.at(-1)!;
			let { github, calls } = fakeGitHub();
			await expect(exportIssues({
				channelId: context.plan.id,
				title: "Export",
				url: "https://chopin.test/doc",
				repository: "owner/repository",
				withPlan: action => action(context.plan),
				github,
			}, { graphNumber: graph.number, graphRevision: graph.revision, by: "test", assignees: {} }))
				.rejects.toThrow("can't become an issue");
			expect(context.plan.issues).toBeUndefined();
			expect(calls).toEqual([]);
		} finally {
			await Service.close(context.plan);
		}
	});

	test("a task ID too long to store is refused before anything is kept", async () => {
		let context = await openPlan("# Export\n");
		try {
			let saved = await implementationGraphs().revise(context.plan, {
				planRevision: 0,
				graphRevision: 0,
				operations: [{ op: "add", task: { ...tasks[1]!, id: "x".repeat(129) } }],
			});
			if (!saved.ok) throw new Error(`graph refused: ${saved.reason}`);
			let graph = context.plan.graph!.versions.at(-1)!;
			let { github, calls } = fakeGitHub();
			await expect(exportIssues({
				channelId: context.plan.id,
				title: "Export",
				url: "https://chopin.test/doc",
				repository: "owner/repository",
				withPlan: action => action(context.plan),
				github,
			}, { graphNumber: graph.number, graphRevision: graph.revision, by: "test", assignees: {} }))
				.rejects.toThrow("longer than 128");
			expect(context.plan.issues).toBeUndefined();
			expect(calls).toEqual([]);
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
