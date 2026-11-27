import { content, expect, test } from "./room";
import type { Graph } from "../apps/server/src/tasks/graphs";

function drafted(): Graph {
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

test("drafted tasks wait for review, and only Approve plan starts them", async ({ seed, join: enter }) => {
	await seed("# Export\n\nPeople can export a document.\n", { graph: drafted() });
	let page = await enter(`ana-${crypto.randomUUID().slice(0, 8)}`);
	let starts: Array<Record<string, unknown>> = [];
	page.on("request", request => {
		if (
			request.method() === "POST" && new URL(request.url()).pathname.endsWith("/implementation")
		) {
			starts.push(request.postDataJSON() as Record<string, unknown>);
		}
	});

	// The slot asks for approval instead of building, and Build is open to read the tasks.
	let approve = page.getByRole("button", { name: "Approve plan", exact: true });
	await expect(approve).toBeVisible();
	await expect(page.getByRole("button", { name: "Build plan", exact: true })).toHaveCount(0);
	let tab = page.getByRole("group", { name: "Document view" })
		.getByRole("button", { name: "Build", exact: true });
	await expect(tab).toBeEnabled();
	await tab.click();
	let view = page.getByRole("region", { name: "Build", exact: true });
	await expect(view.getByText("Ready for review", { exact: true })).toBeVisible();
	await expect(view.getByText("2 tasks", { exact: true })).toBeVisible();
	let tasks = view.getByRole("list", { name: "Tasks" });
	await expect(tasks.getByRole("button", { name: /^Model the export/ })).toBeVisible();
	await expect(tasks.getByRole("button", { name: /^Add the export button/ })).toBeVisible();
	expect(starts).toEqual([]);

	// Approving sends exactly the reviewed version; with no agent connected it says how to start one.
	await view.getByRole("button", { name: "Approve plan", exact: true }).click();
	await expect(page.getByRole("button", { name: "Agent offline", exact: true })).toBeVisible();
	expect(starts).toEqual([{ planRevision: 0, graphVersion: 1, graphRevision: 1 }]);
});

test("an edit before approval puts the tasks out of date, so Build plan drafts them again", async ({ seed, join: enter }) => {
	await seed("# Export\n\nPeople can export a document.\n", { graph: drafted() });
	let page = await enter(`ana-${crypto.randomUUID().slice(0, 8)}`);
	await expect(page.getByRole("button", { name: "Approve plan", exact: true })).toBeVisible();
	await content(page).click();
	await page.keyboard.press("End");
	await page.keyboard.type(" As CSV.");
	await expect(page.getByRole("button", { name: "Build plan", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Approve plan", exact: true })).toHaveCount(0);
	// The out-of-date tasks stay one tab away, with why they are greyed and what brings them back.
	await page.getByRole("group", { name: "Document view" })
		.getByRole("button", { name: "Build", exact: true })
		.click();
	let view = page.getByRole("region", { name: "Build", exact: true });
	await expect(view.getByText("Tasks out of date", { exact: true })).toBeVisible();
	await expect(view.getByText(/Build plan drafts them again for review/)).toBeVisible();
	await expect(view.getByRole("button", { name: "Approve plan", exact: true })).toHaveCount(0);
});
