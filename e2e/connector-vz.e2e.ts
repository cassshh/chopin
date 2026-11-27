import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { content, expect, test } from "./room";
import { ROOT } from "./servers";
import { testChannelPath } from "./database";

/**
 * The connector with its agent in a real Apple Virtualization microVM, against this suite's Chopin:
 * what `connector.e2e.ts` checks with the agent started on the host. It runs on a Mac on Apple
 * silicon where CHOPIN_VZ_ROOT names a package `apps/connector/vz/build.sh` made, and is skipped
 * anywhere else (see docs/vz-sandbox.md).
 */
let usable = process.platform === "darwin" && process.arch === "arm64"
	&& !!process.env.CHOPIN_VZ_ROOT;

test("a Mac's connector pairs, builds its agent's image and runs an investigation in an Apple Virtualization microVM", async ({ baseURL, join: enter, room, seed }) => {
	test.skip(!usable, "needs a Mac on Apple silicon and CHOPIN_VZ_ROOT");
	// The agent's image is built before the connector offers to pair.
	test.setTimeout(360_000);
	await seed("# Local investigation\n\nInspect startup evidence.\n");
	let root = await mkdtemp(join(tmpdir(), "chopin-connector-vz-"));
	let state = await mkdtemp(join(tmpdir(), "chopin-connector-vz-state-"));
	let inputs = await mkdtemp(join(tmpdir(), "chopin-connector-vz-inputs-"));
	let git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
	git("init");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.test");
	git("remote", "add", "origin", "https://github.com/octo-org/score.git");
	await writeFile(join(root, "sample.txt"), "sample");
	git("add", ".");
	git("commit", "-m", "fixture");
	// The fake agent as one file Node runs, which the image's build reads from the host
	// (`--install-from`): its guest has Node, not Bun, and nothing of this checkout.
	execFileSync("bun", [
		"build",
		join(ROOT, "apps/connector/src/testing/fake-agent.ts"),
		"--target=node",
		"--format=cjs",
		"--banner=#!/usr/bin/env node",
		`--outfile=${join(inputs, "fake-agent")}`,
	], { cwd: ROOT, stdio: "pipe" });
	await chmod(join(inputs, "fake-agent"), 0o755);
	let connector = spawn("bun", [
		join(ROOT, "apps/connector/src/main.ts"),
		"connect",
		".",
		"--install",
		'install -m 755 /install-from/fake-agent "$npm_config_prefix/bin/fake-agent"',
		"--install-from",
		inputs,
		"--",
		"fake-agent",
	], {
		cwd: root,
		env: { ...process.env, CHOPIN_URL: baseURL, CHOPIN_CONNECTOR_STATE_DIR: state },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	let pairing = new Promise<string>((resolve, reject) => {
		let timeout = setTimeout(
			() => reject(new Error(`Connector did not offer pairing: ${output}`)),
			240_000,
		);
		let read = (chunk: Buffer) => {
			output += String(chunk);
			let match = output.match(/http:\/\/[^\s]+\/machines\?pairing=[\w-]+/);
			if (match) {
				clearTimeout(timeout);
				resolve(match[0]);
			}
		};
		connector.stdout.on("data", read);
		connector.stderr.on("data", read);
		connector.once("error", reject);
		connector.once("exit", code => {
			clearTimeout(timeout);
			reject(new Error(`Connector exited ${code}: ${output}`));
		});
	});
	try {
		let page = await enter(`ana-${crypto.randomUUID().slice(0, 8)}`);
		await page.goto(await pairing);
		let printed = () => output.match(/Check the page shows:\s+([A-Z2-9]{4}-[A-Z2-9]{4})/)?.[1];
		await expect.poll(printed).toBeTruthy();
		await expect(page.getByText(printed()!, { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Add machine", exact: true }).click();
		await expect(page.getByRole("status").filter({ hasText: "Connected" }))
			.toHaveText("Connected");
		// The agent Chopin names is the one that answered from its microVM.
		await expect(page.getByText("Fake Agent 1.2.3")).toBeVisible();
		await page.goto(testChannelPath(room));
		await content(page).click();
		await page.keyboard.press("ControlOrMeta+End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("/investigate");
		await page.getByRole("listbox", { name: "Insert block" })
			.getByRole("option", { name: "Investigate", exact: true })
			.click();
		await page.getByRole("textbox", { name: "Investigation brief", exact: true }).fill(
			"Produce the captured startup fixture",
		);
		await page.getByRole("button", { name: "Propose investigation", exact: true }).click();
		await page.getByRole("article", { name: "Investigation", exact: true })
			.getByRole("button", { name: "Run", exact: true })
			.click();
		// The agent, in its microVM, published its result through the run's MCP bridge.
		await expect(page.getByRole("button", { name: /^Open Startup comparison/ }))
			.toBeVisible({ timeout: 60_000 });
		expect(output).toContain("› Investigating Produce the captured startup fixture");
	} finally {
		connector.kill("SIGINT");
		await new Promise<void>(resolve => {
			if (connector.exitCode !== null) return resolve();
			let timer = setTimeout(() => {
				connector.kill("SIGKILL");
				resolve();
			}, 10_000);
			connector.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
		await rm(inputs, { recursive: true, force: true });
		expect(connector.exitCode, output).toBe(0);
	}
});
