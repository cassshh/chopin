import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installVz, VZ_RELEASE, vzDirectory, vzPackageUrl, type VzRelease } from "./nvx";
import { installedArtifacts } from "./sandbox";

let scratch = mkdtempSync(join(tmpdir(), "chopin-vz-package-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function sha256(path: string) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** A package as `build.sh --archive` lays one out, with made-up files, and its pin. */
function madeUpPackage(name: string, change?: (folder: string) => void) {
	let folder = join(scratch, name);
	mkdirSync(join(folder, "bin"), { recursive: true });
	mkdirSync(join(folder, "guest"));
	writeFileSync(join(folder, "bin", "chopin-vz"), "#!/bin/sh\n", { mode: 0o755 });
	writeFileSync(join(folder, "guest", "ubuntu-distro.erofs"), "layer");
	writeFileSync(
		join(folder, "guest", "ubuntu-distro.erofs.manifest.json"),
		JSON.stringify({ uuid: "11111111-2222-4333-8444-555555555555" }),
	);
	let files = [
		"bin/chopin-vz",
		"guest/ubuntu-distro.erofs",
		"guest/ubuntu-distro.erofs.manifest.json",
	];
	writeFileSync(
		join(folder, "SHA256SUMS"),
		files.map(file => `${sha256(join(folder, file))}  ${file}\n`).join(""),
	);
	change?.(folder);
	let archive = join(scratch, `${name}.tar.gz`);
	let packed = spawnSync("tar", ["-czf", archive, "-C", folder, "bin", "guest", "SHA256SUMS"]);
	if (packed.status !== 0) throw new Error(String(packed.stderr));
	let release: VzRelease = {
		version: "9.9.9",
		tag: "vz-v9.9.9",
		file: "chopin-vz-9.9.9-darwin-arm64.tar.gz",
		sha256: sha256(archive),
	};
	return { archive, release };
}

async function unpack(archive: string, into: string) {
	let unpacked = spawnSync("tar", ["-xzf", archive, "-C", into]);
	if (unpacked.status !== 0) throw new Error(String(unpacked.stderr));
}

describe("the Apple Virtualization package", () => {
	test("is pinned by a SHA-256 and downloaded from its own release's asset", () => {
		expect(VZ_RELEASE.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(vzPackageUrl()).toBe(
			`https://github.com/cassshh/chopin/releases/download/vz-v${VZ_RELEASE.version}/chopin-vz-${VZ_RELEASE.version}-darwin-arm64.tar.gz`,
		);
	});

	test("is installed where the connector finds it, once its archive and every file in it match, and older ones go", async () => {
		let { archive, release } = madeUpPackage("good");
		let base = join(scratch, "state-good");
		mkdirSync(join(base, "vz", "0.0.1"), { recursive: true });
		let asked: string[] = [];
		let artifacts = await installVz(
			base,
			async (url, path) => {
				asked.push(url);
				copyFileSync(archive, path);
			},
			unpack,
			undefined,
			release,
		);
		expect(asked).toEqual([vzPackageUrl(release)]);
		let installed = vzDirectory(base, release.version);
		expect(artifacts.nvx).toBe(join(installed, "bin", "chopin-vz"));
		expect(artifacts.layer.uuid).toBe("11111111-2222-4333-8444-555555555555");
		expect(readFileSync(join(installed, ".verified"), "utf8")).toBe("9.9.9\n");
		expect(existsSync(join(base, "vz", "0.0.1"))).toBe(false);
		// Nothing of the download is left beside it.
		expect(spawnSync("ls", [join(base, "vz")], { encoding: "utf8" }).stdout.trim()).toBe("9.9.9");
	});

	test("the pinned version is found in the state directory without CHOPIN_VZ_ROOT", () => {
		let base = join(scratch, "state-found");
		let installed = vzDirectory(base);
		mkdirSync(join(installed, "bin"), { recursive: true });
		mkdirSync(join(installed, "guest"));
		writeFileSync(join(installed, "bin", "chopin-vz"), "");
		writeFileSync(join(installed, "guest", "ubuntu-distro.erofs"), "");
		writeFileSync(
			join(installed, "guest", "ubuntu-distro.erofs.manifest.json"),
			JSON.stringify({ uuid: "11111111-2222-4333-8444-555555555555" }),
		);
		// Not without the mark an install or build.sh leaves once it is whole.
		expect(installedArtifacts(base, {}, "darwin")).toBeUndefined();
		writeFileSync(join(installed, ".verified"), "");
		expect(installedArtifacts(base, {}, "darwin")?.nvx).toBe(join(installed, "bin", "chopin-vz"));
	});

	test("an archive that isn't the pinned one installs nothing", async () => {
		let { archive, release } = madeUpPackage("other");
		let base = join(scratch, "state-other");
		let refused = installVz(
			base,
			async (_url, path) => copyFileSync(archive, path),
			unpack,
			undefined,
			{ ...release, sha256: "0".repeat(64) },
		);
		await expect(refused).rejects.toThrow("isn't the one this chopin pins");
		expect(existsSync(vzDirectory(base, release.version))).toBe(false);
	});

	test("a file changed inside the archive installs nothing", async () => {
		let { archive, release } = madeUpPackage("tampered", folder => {
			writeFileSync(join(folder, "bin", "chopin-vz"), "#!/bin/sh\necho changed\n");
		});
		let base = join(scratch, "state-tampered");
		let refused = installVz(
			base,
			async (_url, path) => copyFileSync(archive, path),
			unpack,
			undefined,
			release,
		);
		await expect(refused).rejects.toThrow("don't match its SHA256SUMS: bin/chopin-vz: differs");
		expect(existsSync(vzDirectory(base, release.version))).toBe(false);
	});

	test("a download that fails says so, and how to use a package built on the Mac", async () => {
		let base = join(scratch, "state-offline");
		let refused = installVz(
			base,
			async () => {
				throw new Error("the asset answered 404");
			},
			unpack,
		);
		await expect(refused).rejects.toThrow(
			`Couldn't download chopin's Apple Virtualization package ${VZ_RELEASE.version}: the asset answered 404. To use one built on this Mac instead, run apps/connector/vz/build.sh from a Chopin checkout.`,
		);
		expect(existsSync(vzDirectory(base))).toBe(false);
	});
});
