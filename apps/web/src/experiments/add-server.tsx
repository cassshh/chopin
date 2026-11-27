import { useEffect, useId, useState } from "react";
import { safeSessionStorage } from "@chopin/editor/browser-storage";
import { GitHubIcon, RestartIcon } from "@chopin/icons";
import { InlineNotice } from "@chopin/visuals/inline-notice";
import {
	AgentChoice,
	Command,
	foreground,
	Needs,
	Setting,
	shellPlace,
	SystemChoice,
	useAgent,
	useSystem,
} from "./machine-setup";
import { useRecommendedVersion } from "./machines";
import { expiryLabel, usePairingKey } from "./pairing-key";
import { keyProblem } from "./pairing-problems";
import {
	isSetupAgent,
	runsAsService,
	setupAgentCommand,
	setupCommand,
	shellFor,
} from "./setup-commands";

import type { KeyChoices, PairingKey } from "./pairing-key";
import type { SetupSystem } from "./setup-commands";

/** The server page's choices, kept for this tab across the trip to GitHub and back. */
const SETTINGS_KEY = "chopin:machines:server";

type Settings = {
	system?: SetupSystem;
	background?: boolean;
	autoRun?: boolean;
	shared?: boolean;
	name?: string;
};

function storedSettings(): Settings {
	try {
		let value = JSON.parse(safeSessionStorage.getItem(SETTINGS_KEY) ?? "{}");
		return value && typeof value === "object" ? value as Settings : {};
	} catch {
		return {};
	}
}

/** What stands in the command's place before there is a key to put in it. */
function Generate(
	{ choices, generate, pairing }: {
		choices: KeyChoices;
		generate: (choices: KeyChoices) => void;
		pairing: Exclude<PairingKey, { state: "ready" }>;
	},
) {
	if (pairing.state === "failed") {
		let problem = keyProblem(pairing.code);
		return (
			<InlineNotice
				actions={problem.retry && (
					<button
						className="btn btn-xs btn-outline"
						onClick={() => generate(choices)}
						type="button"
					>
						<RestartIcon aria-hidden="true" />
						Try again
					</button>
				)}
				message={problem.body}
				title={problem.title}
			/>
		);
	}
	if (pairing.state === "authorize") {
		return (
			<div className="machines-generate" aria-busy={pairing.going || undefined}>
				{pairing.going
					? <p className="machines-detail">Checking with GitHub…</p>
					: (
						<>
							<button
								className="btn btn-md btn-primary"
								onClick={() => generate(choices)}
								type="button"
							>
								<GitHubIcon aria-hidden="true" />
								Continue with GitHub
							</button>
							<p className="machines-detail">GitHub confirms it's you before Chopin makes a key.</p>
						</>
					)}
			</div>
		);
	}
	let busy = pairing.state === "minting";
	return (
		<div className="machines-generate">
			<button
				aria-busy={busy || undefined}
				className="btn btn-md btn-primary"
				disabled={busy}
				onClick={() => generate(choices)}
				type="button"
			>
				{busy
					? "Generating…"
					: pairing.state === "expired"
					? "Re-generate install script"
					: "Generate install script"}
			</button>
			{pairing.state === "expired" && <p className="machines-detail">That key expired.</p>}
		</div>
	);
}

/** A key's time left, said again each quarter minute. */
function Expiry({ expiresAt }: { expiresAt: number }) {
	let [now, setNow] = useState(Date.now);
	useEffect(() => {
		let timer = window.setInterval(() => setNow(Date.now()), 15_000);
		return () => window.clearInterval(timer);
	}, []);
	return <span className="machines-key-expiry">{expiryLabel(expiresAt, now)}</span>;
}

/** The machine's name in Chopin, optional: chopin uses the machine's hostname without one. */
function MachineName({ name, onChange }: { name: string; onChange: (name: string) => void }) {
	let fieldId = useId();
	let helpId = useId();
	return (
		<div className="machines-setting">
			<div className="machines-name">
				<label htmlFor={fieldId}>Machine name</label>
				<input
					aria-describedby={helpId}
					autoComplete="off"
					className="field"
					id={fieldId}
					maxLength={64}
					onChange={event => onChange(event.currentTarget.value)}
					placeholder="hostname"
					spellCheck={false}
					value={name}
				/>
			</div>
			<p className="machines-setting-detail" id={helpId}>
				Optional. Without one, Chopin names the machine after its hostname.
			</p>
		</div>
	);
}

/**
 * Add a cloud machine: name the machine if you like, choose the agent, whether it runs in the background and whether Chopin may build
 * and prototype on it by itself, then generate an install script with a single-use key, which
 * pairs the machine with no browser. The key is made only when Generate is pressed. The page ends
 * at the command; the machine appears in the Machines table when it connects.
 */
export function AddServerPage() {
	let [saved] = useState(storedSettings);
	let [system, setSystem] = useSystem(saved.system);
	let { agent, options, choose } = useAgent("server");
	let [background, setBackground] = useState(saved.background ?? true);
	let recommended = useRecommendedVersion();
	let [autoRun, setAutoRun] = useState(saved.autoRun ?? false);
	let [shared, setShared] = useState(saved.shared ?? false);
	let [name, setName] = useState(saved.name ?? "");
	let choices = { autoRun, shared };
	let { key: pairing, generate, reset } = usePairingKey();
	// Without storage the page starts from its defaults after GitHub.
	useEffect(() => {
		safeSessionStorage.setItem(
			SETTINGS_KEY,
			JSON.stringify({ system, background, autoRun, shared, name }),
		);
	}, [system, background, autoRun, shared, name]);
	let shell = shellFor(system);
	// A setup agent's own command decides how the machine connects, service included.
	let setup = isSetupAgent(agent) ? agent : undefined;
	let builtIn = isSetupAgent(agent) ? undefined : agent;
	let runsInBackground = !!builtIn && runsAsService(builtIn) && background;
	return (
		<ol className="machines-steps">
			<li className="machines-step">
				<h2 className="machines-step-title">Set up the machine</h2>
				<div className="machines-settings">
					<MachineName name={name} onChange={setName} />
					<div className="machines-setting">
						<AgentChoice agent={agent} onChange={choose} options={options} />
						<Needs agent={agent} system={system} />
					</div>
					{builtIn && (
						<Setting
							checked={runsInBackground}
							disabled={foreground(builtIn)}
							onChange={setBackground}
							title="Stay connected"
						>
							chopin starts with the machine and stays connected after you log out.
						</Setting>
					)}
					<Setting
						checked={autoRun}
						onChange={value => {
							setAutoRun(value);
							// A key carries the choice it was made with, so a new choice needs a new key.
							if (pairing.state !== "idle") reset();
						}}
						title="Build and prototype automatically"
					>
						Off: work runs here only when you press Build or Run. On: Chopin can also rebuild what
						you built when its document changes, and prototype passages you write.
					</Setting>
					<Setting
						checked={shared}
						onChange={value => {
							setShared(value);
							if (pairing.state !== "idle") reset();
						}}
						title="Run teammates' work"
					>
						Off: nobody else's work runs here. On: teammates see this machine and can choose it for
						a document, and that document's replies, builds and runs then happen here as you, with
						your GitHub account, in repositories you can push to. Rebuilds and prototypes Chopin
						starts by itself stay yours.
					</Setting>
				</div>
			</li>
			<li className="machines-step">
				<h2 className="machines-step-title">Generate install script</h2>
				<SystemChoice onChange={setSystem} system={system} />
				{pairing.state === "ready"
					? (
						<div className="machines-run">
							<div className="machines-key">
								<button
									className="btn btn-md btn-secondary"
									onClick={() => generate(choices)}
									type="button"
								>
									Re-generate install script
								</button>
								<Expiry expiresAt={pairing.expiresAt} />
							</div>
							<p className="machines-run-lead">In your terminal, run:</p>
							<Command
								label="install script"
								place={shellPlace(shell)}
								text={setup
									? setupAgentCommand(setup, system, {
										origin: location.origin,
										key: pairing.key,
										name,
									})!
									: setupCommand(location.origin, shell, builtIn!, {
										...(recommended ? { version: recommended } : {}),
										key: pairing.key,
										background: runsInBackground,
										name,
									})}
							/>
							{!setup && !runsInBackground && (
								<p className="machines-detail">Keep the terminal open.</p>
							)}
						</div>
					)
					: <Generate choices={choices} generate={generate} pairing={pairing} />}
			</li>
		</ol>
	);
}
