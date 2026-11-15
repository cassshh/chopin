import { expect, test } from "./room";
import { failedBuild } from "./build-seed";
import type { Graph } from "../apps/server/src/tasks/graphs";

function graph(): Graph {
	return {
		versions: [{
			number: 1,
			revision: 1,
			planRevision: 0,
			state: "draft",
			definition: {
				tasks: [{
					id: "model",
					title: "Model the export",
					context: "The document needs an export shape.",
					goal: "An Export type exists.",
					acceptance: ["It type checks.", "It names the format."],
					dependsOn: [],
				}, {
					id: "button",
					title: "Add the export button",
					context: "People need a way to export.",
					goal: "The header shows Export.",
					acceptance: ["Writers see Export.", "Readers do not."],
					dependsOn: ["model"],
				}],
			},
		}],
	};
}

test("a built plan's tasks become GitHub issues with the assignee picked for each", async ({ seed, join: enter }) => {
	let seeded = graph();
	await seed("# Export\n\nPeople can export a document.\n", {
		graph: seeded,
		builds: [failedBuild(seeded)],
	});
	let page = await enter("ana");
	await page.getByRole("group", { name: "Document view" })
		.getByRole("button", { name: "Build", exact: true })
		.click();
	let view = page.getByRole("region", { name: "Build", exact: true });
	await view.getByRole("button", { name: "Create issues", exact: true }).click();
	let form = view.getByRole("form");
	await expect(form.getByText("Each task becomes a sub-issue")).toBeVisible();
	await form.getByRole("combobox", { name: "Assignee for Add the export button" })
		.selectOption({ label: "Copilot" });
	await form.getByRole("button", { name: "Create 2 issues", exact: true }).click();

	await expect(form).toBeHidden();
	await expect(view.getByText("Tracked as GitHub issues")).toBeVisible();
	await expect(view.getByRole("link", { name: /^Parent issue #\d+$/ })).toBeVisible();
	// Everyone in the document hears about it in Chat, with the parent issue linked.
	await expect(
		page.getByRole("complementary", { name: "Chat" }).getByText(
			/made this document’s tasks into #\d+ with 2 issues under it/,
		),
	)
		.toBeVisible();
	let issues = view.getByRole("list", { name: "Tasks" }).getByRole("link", {
		name: /^Issue #\d+$/,
	});
	await expect(issues).toHaveCount(2);
	await expect(issues.first()).toHaveAttribute(
		"href",
		/^https:\/\/github\.com\/octo-org\/score\/issues\/\d+$/,
	);
	// Everything is made, so there is nothing left to create.
	await expect(view.getByRole("button", { name: /Create (missing )?issues/ })).toHaveCount(0);
	await view.getByRole("button", { name: /Add the export button/ }).click();
	await expect(view.getByText("Assigned to Copilot")).toBeVisible();

	// The links are stored: a reload shows them again.
	await page.reload();
	await page.getByRole("group", { name: "Document view" })
		.getByRole("button", { name: "Build", exact: true })
		.click();
	await expect(
		page.getByRole("region", { name: "Build", exact: true }).getByRole("link", {
			name: /^Issue #\d+$/,
		}),
	).toHaveCount(2);
});

test("tasks under review can be handed off as issues instead, and still be approved later", async ({ seed, join: enter }) => {
	await seed("# Export\n\nPeople can export a document.\n", { graph: graph() });
	let page = await enter(`ana-${crypto.randomUUID().slice(0, 8)}`);
	await expect(page.getByRole("button", { name: "Approve plan", exact: true })).toBeVisible();
	await page.getByRole("group", { name: "Document view" })
		.getByRole("button", { name: "Build", exact: true })
		.click();
	let view = page.getByRole("region", { name: "Build", exact: true });
	await expect(view.getByText("Ready for review", { exact: true })).toBeVisible();
	// The two ways on from review: build here, or hand off as issues.
	await expect(view.getByRole("button", { name: "Approve plan", exact: true })).toBeVisible();
	await view.getByRole("button", { name: "Create issues", exact: true }).click();
	await view.getByRole("form").getByRole("button", { name: "Create 2 issues", exact: true })
		.click();

	await expect(view.getByText("Handed off as issues", { exact: true })).toBeVisible();
	await expect(view.getByRole("link", { name: /^Parent issue #\d+$/ })).toBeVisible();
	await expect(
		view.getByRole("list", { name: "Tasks" }).getByRole("link", { name: /^Issue #\d+$/ }),
	)
		.toHaveCount(2);
	// The header names the issues, with Approve plan as the second choice.
	await expect(page.getByRole("button", { name: /^Issues in #\d+$/ })).toBeVisible();
	await expect(page.getByRole("button", { name: "Approve plan", exact: true }).first())
		.toBeVisible();
});
