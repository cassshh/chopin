import { usePendingWork } from "@chopin/editor";
import { Face } from "@chopin/editor/face";
import { sentenceCase } from "./sentence-case";
import {
	CheckIcon,
	IssueOpenIcon,
	LoaderIcon,
	MachineIcon,
	ProgressRingIcon,
	PullRequestClosedIcon,
	PullRequestMergedIcon,
	PullRequestOpenIcon,
	ServerIcon,
	WarningIcon,
} from "@chopin/icons";
import { Fragment, useEffect, useId, useState } from "react";
import { AI_ACCOUNTS_PATH, noAiAccountRun } from "@chopin/protocol/ai-credentials";
import { navigateTo } from "./chat/navigate";

import { BuildGlyph } from "./build-plan-button";
import {
	ago,
	attentionHint,
	blockerLabelled,
	blockerText,
	buildAgo,
	buildLabel,
	buildPhase,
	buildProgress,
	builtCount,
	builtDetail,
	endedCard,
	linkParts,
	liveTaskGroups,
	liveTaskState,
	planSourceLine,
	plural,
	pullRequestCommits,
	pullRequestNumber,
	retryAction,
	taskRowName,
	taskStartsOpen,
	unfinishedReason,
} from "./build-model";
import {
	cancelBuildRequest,
	createIssues,
	implementationEndpoint,
	implementationResponse as response,
	stopBuild,
} from "./build-start";
import { useDocumentPeople } from "./chat/document-people";
import { inlineText } from "./chat/inline-text";
import { InlineMarkdown, MessageMarkdown } from "./chat/markdown";
import { LocalAgentNote } from "./local-agent-note";
import { MachineGlyph } from "./machine-button";
import "./build-source.css";

import type { ReactNode } from "react";
import type { BuildPlan } from "./build-plan-button";
import type { TaskState } from "./build-model";
import type {
	BuildMachine,
	BuildRequest,
	IssueExportSnapshot,
} from "@chopin/protocol/implementation";

/** What the status card says: a title and count, one line under it, and per-task progress. */
type Card = {
	title: string;
	count?: string;
	glyph?: ReactNode;
	detail?: ReactNode;
	/** What the coding agent says it is doing now, in place of `detail`. */
	activity?: string;
	segments?: TaskState[];
};

function CardSpinner() {
	return (
		<span aria-hidden="true" className="build-glyph">
			<LoaderIcon aria-hidden="true" className="build-glyph-quiet build-card-spin" />
		</span>
	);
}

/**
 * The machine a build runs on, as everyone sees it. Only its starter is told whether it is
 * online, so the state dot shows only for them.
 */
function MachineLabel({ machine }: { machine: BuildMachine }) {
	let Icon = machine.service ? ServerIcon : MachineIcon;
	return (
		<span
			className="build-card-machine"
			title={machine.connected === false
				? `${machine.label} is offline`
				: machine.owner
				? `${machine.label}, ${machine.owner}'s machine`
				: undefined}
		>
			{machine.connected === undefined
				? (
					<span aria-hidden="true" className="machine-glyph">
						<Icon size={16} />
					</span>
				)
				: (
					<MachineGlyph
						machine={{ service: machine.service, connected: machine.connected, reauthorize: false }}
					/>
				)}
			<span className="build-card-machine-name">{machine.label}</span>
		</span>
	);
}

/**
 * The build's status and its tasks. Opening this view never starts anything: the header's Build
 * plan drafts tasks, and Approve plan (in the header, or on the review card here, beside the
 * tasks it approves) starts them. It keeps the recoveries that need its context, such as Return
 * to planning.
 */
export function BuildView(
	{
		active,
		build,
		canEdit,
		comments,
		machineOffline,
		onShowDocument,
		room,
		userId,
	}: {
		active: boolean;
		build: BuildPlan;
		canEdit: boolean;
		/** The chosen machine is offline, named: Approve plan waits for it, as in the header. */
		machineOffline?: string;
		/** Accepted comments the document has not yet taken in. */
		comments: number;
		onShowDocument: () => void;
		room: string;
		userId: string;
	},
) {
	let { look, snapshot, loadError } = build;
	let [actionError, setActionError] = useState<string>();
	let [busy, setBusy] = useState(false);
	let [stopping, setStopping] = useState(false);
	let [returning, setReturning] = useState(false);
	let [reason, setReason] = useState("");
	usePendingWork(returning && reason.trim() !== "");
	let [open, setOpen] = useState<Record<string, boolean>>({});
	// Create issues: the assignee picked per task, as a login, `copilot` or "" for nobody.
	let [assigning, setAssigning] = useState(false);
	let [assignees, setAssignees] = useState<Record<string, string>>({});
	let [creating, setCreating] = useState(false);
	let people = useDocumentPeople(room, assigning);
	let [linked, setLinked] = useState<string>();
	let [now, setNow] = useState(() => Date.now());
	let sinceHeading = useId();
	let endpoint = implementationEndpoint(room);
	let phase = buildPhase(snapshot);
	let progress = buildProgress(snapshot);
	let activeBuild = [snapshot?.live?.rebuild, snapshot?.build].find(item =>
		item && ["queued", "starting", "running"].includes(item.state)
	);

	let pending = phase.kind === "building" || phase.kind === "live";
	useEffect(() => {
		if (!pending || !active) return;
		setNow(Date.now());
		let timer = window.setInterval(() => setNow(Date.now()), 30_000);
		return () => window.clearInterval(timer);
	}, [pending, active]);

	useEffect(() => {
		let follow = () => {
			if (!location.hash.startsWith("#task-")) return;
			let id = location.hash.slice("#task-".length);
			setLinked(id);
			setOpen(current => ({ ...current, [id]: true }));
		};
		follow();
		addEventListener("hashchange", follow);
		return () => removeEventListener("hashchange", follow);
	}, []);

	let graphNumber = snapshot?.graph?.number;
	useEffect(() => {
		if (!active || !linked || graphNumber === undefined) return;
		requestAnimationFrame(() => {
			document.getElementById(`task-${linked}`)?.scrollIntoView({ block: "nearest" });
		});
	}, [active, linked, graphNumber]);

	let returnToPlanning = async () => {
		if (!snapshot?.build || busy) return;
		setBusy(true);
		setActionError(undefined);
		try {
			await response(
				await fetch(`${endpoint}/revise`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ buildId: snapshot.build.id, reason }),
				}),
			);
			setReason("");
			setReturning(false);
			build.reload();
		} catch (error) {
			setActionError(sentenceCase(error instanceof Error ? error.message : "Return failed"));
		} finally {
			setBusy(false);
		}
	};

	// A living document lists its first build's tasks and every rebuild's after them.
	let tasks = phase.kind === "live"
		? snapshot?.live?.tasks ?? []
		: snapshot?.graph?.definition.tasks ?? [];
	let staleTasks = phase.kind === "drafting" && tasks.length > 0;
	let breaking = look.kind === "tasks" && phase.kind !== "review";
	let showTasks = tasks.length > 0 && phase.kind !== "loading" && !breaking
		&& !(phase.kind === "blocked" && phase.stale)
		&& !(phase.kind === "drafting" && !staleTasks);

	let outstanding = new Set(snapshot?.live?.outstandingTasks?.map(task => task.id));
	let rebuilding = phase.kind === "live" && phase.sync.kind === "building";
	let reportFor = (task: (typeof tasks)[number]) =>
		phase.kind === "live"
			? snapshot?.live?.tasks.find(item => item.id === task.id)?.progress
			: progress?.tasks.find(item => item.id === task.id);
	let stateFor = (task: (typeof tasks)[number], report = reportFor(task)): TaskState =>
		phase.kind === "live"
			? liveTaskState(report?.state ?? "queued", outstanding.has(task.id), rebuilding)
			: report?.state ?? "queued";

	// The graph's tasks can become GitHub issues once drafted or built, while no build runs.
	let issues = snapshot?.issues;
	let graphTasks = snapshot?.graph?.definition.tasks ?? [];
	let exportable = canEdit && graphTasks.length > 0 && !activeBuild && !issues?.running
		&& ["review", "done", "failed", "stopped", "live"].includes(phase.kind);
	let unfinished = graphTasks.filter(task => {
		let entry = issues?.tasks[task.id];
		return !entry?.number || !!entry.problem || !!entry.assignee && !entry.assigned;
	});
	let createAll = async () => {
		let graph = snapshot?.graph;
		if (!graph || creating) return;
		setCreating(true);
		setActionError(undefined);
		try {
			await createIssues(room, {
				graphNumber: graph.number,
				graphRevision: graph.revision,
				assignees: Object.fromEntries(
					unfinished
						.filter(task => !issues?.tasks[task.id]?.assigned)
						.map(task => [task.id, assignees[task.id] || null]),
				),
			});
			setAssigning(false);
		} catch (error) {
			setActionError(
				sentenceCase(error instanceof Error ? error.message : "Couldn’t create the issues"),
			);
		} finally {
			setCreating(false);
			build.reload();
		}
	};
	let issuesAction: ReactNode = issues?.running || creating
		? (
			<span className="build-card-quiet" role="status">
				<LoaderIcon aria-hidden="true" className="build-card-spin" /> Creating issues
			</span>
		)
		: exportable && unfinished.length > 0 && !assigning
		? (
			<button
				className="btn btn-sm btn-outline shrink-0"
				onClick={() => {
					setActionError(undefined);
					setAssignees(Object.fromEntries(
						graphTasks.flatMap(task => {
							let assignee = issues?.tasks[task.id]?.assignee;
							return assignee ? [[task.id, assignee]] : [];
						}),
					));
					setAssigning(true);
				}}
				type="button"
			>
				{issues?.parent ? "Create missing issues" : "Create issues"}
			</button>
		)
		: undefined;

	let action: ReactNode;
	function statusCard(): Card {
		// Drafted tasks wait here for review; Approve plan approves exactly these and starts them.
		if (look.kind === "review") {
			return {
				title: "Ready for review",
				count: plural(look.tasks, "task", "tasks"),
				// An element, not a string: a sentence this long wraps instead of fading in on one line.
				detail: look.blocked ?? (
					<span>
						{build.reviewChanged
							? "The tasks changed while you were reviewing them, so nothing was approved. Read them again, then approve."
							: machineOffline
							? `${machineOffline}. Approve plan builds these tasks once it is back, or on another machine you choose.`
							: "Read the tasks below, then Approve plan builds them on your machine. Editing the document drafts them again."}
					</span>
				),
			};
		}
		if (look.kind === "plan") {
			// Built before, now back in planning: Build plan in the header builds it again.
			if (phase.kind === "blocked") {
				return {
					title: "Waiting to build",
					glyph: <span aria-hidden="true" className="build-glyph-dot" data-tone="warning" />,
					detail: phase.comments
						? (
							<span className="build-blockers">
								<button className="build-link link" onClick={onShowDocument} type="button">
									{comments > 0
										? `Update the document for ${
											plural(comments, "accepted comment", "accepted comments")
										} first`
										: "Update the document for accepted comments first"}
								</button>
							</span>
						)
						: "This document can’t be built yet.",
				};
			}
			// Who stopped it, the task its agent blocked, or why it failed, as Chat's end line says.
			if (phase.kind === "drafting" && phase.draft === "returned" && snapshot) {
				return endedCard(snapshot);
			}
			// Drafted for an older revision: say why they are greyed and what brings them up to date.
			if (phase.kind === "drafting" && phase.draft === "revise" && staleTasks) {
				return {
					title: "Tasks out of date",
					detail: (
						<span>
							The document changed after these tasks were drafted. Build plan drafts them again for
							review.
						</span>
					),
				};
			}
			return { title: "Not built yet" };
		}
		if (look.kind === "tasks") {
			return {
				title: "Preparing tasks",
				glyph: <CardSpinner />,
				detail: look.tip === "Breaking the document into tasks" ? undefined : look.tip,
			};
		}
		let states = tasks.map(task => stateFor(task));
		let done = states.filter(state => state === "completed").length;
		let count = tasks.length
			? `${done} of ${plural(tasks.length, "task", "tasks")}`
			: undefined;
		let base = { count, segments: states, activity: activeBuild?.activity?.text };
		if (look.kind === "building") {
			let queued = activeBuild?.state === "queued";
			return {
				...base,
				title: stopping ? "Stopping" : queued ? "Queued" : "Building",
				glyph: queued
					? <CardSpinner />
					: (
						<span aria-hidden="true" className="build-glyph" data-live="">
							<ProgressRingIcon progress={Math.max(look.done / look.total, 0.08)} />
						</span>
					),
				detail: snapshot?.waitingForDocument || snapshot?.waitingForPrototype
					? look.tip
					: undefined,
			};
		}
		if (look.kind === "rebuilding") {
			return {
				...base,
				title: stopping ? "Stopping" : "Building changes",
				glyph: <CardSpinner />,
				detail: look.tip,
			};
		}
		if (look.kind === "built") {
			return {
				...base,
				title: "Built",
				count: builtCount(look),
				glyph: <CheckIcon aria-hidden="true" className="build-card-check" />,
				detail: builtDetail(snapshot),
			};
		}
		if (look.kind === "stopped" || look.kind === "failed" || look.kind === "agent") {
			return {
				...base,
				title: look.kind === "failed" && phase.kind === "live"
					? "Rebuild failed"
					: buildLabel(look),
				glyph: (
					<span aria-hidden="true" className="build-glyph">
						<WarningIcon aria-hidden="true" className="build-glyph-warning" />
					</span>
				),
				// The note below says how to start the agent; a blocked row shows the blocker.
				detail: look.kind === "agent"
					? undefined
					: look.kind === "failed" && phase.kind === "live"
							&& phase.sync.kind === "needs-attention"
					? attentionHint(snapshot, true) ?? look.tip
					: look.tip,
			};
		}
		return {
			...base,
			title: buildLabel(look),
			glyph: <BuildGlyph look={look} />,
			detail: look.tip,
		};
	}

	let card = phase.kind === "loading" ? undefined : statusCard();

	// The build the card's footer names: the one running, else the last that ran.
	let shown:
		| Pick<BuildRequest, "id" | "user" | "state" | "planSource"> & {
			createdAt?: string;
			finishedAt?: string;
		}
		| undefined = look.kind === "plan" || look.kind === "tasks"
			? undefined
			: activeBuild ?? (phase.kind === "live" && snapshot?.live
				? snapshot.live.rebuild
					?? (snapshot.build?.id === snapshot.live.buildId
						? snapshot.build
						: { id: snapshot.live.buildId, user: snapshot.live.user, state: "stopped" })
				: snapshot?.build);
	let login = shown && (
		shown.id === snapshot?.build?.id
			? snapshot.startedBy
			: shown.user === snapshot?.live?.user
			? snapshot.builtBy
			: undefined
	);
	let machine = shown && snapshot?.buildMachines?.[shown.id];
	let when = buildAgo(shown, now);
	let from = planSourceLine(shown);

	if (look.kind === "review" && canEdit) {
		// An offline chosen machine holds approval here as it does in the header.
		let blocked = look.blocked ?? machineOffline;
		action = (
			<button
				aria-busy={build.busy || undefined}
				aria-disabled={blocked || build.busy ? true : undefined}
				className={`btn btn-sm btn-primary shrink-0${
					!look.blocked && machineOffline ? " machine-offline" : ""
				}`}
				// Offline is said in the card's text above, as the header says it only to screen readers.
				data-tooltip={look.blocked}
				onClick={() => {
					if (blocked || build.busy) return;
					setActionError(undefined);
					build.approve();
				}}
				type="button"
			>
				Approve plan
			</button>
		);
	}
	if (phase.kind === "stopped" && canEdit && !returning) {
		action = (
			<button
				className="btn btn-sm btn-outline shrink-0"
				onClick={() => setReturning(true)}
				type="button"
			>
				Return to planning
			</button>
		);
	}
	// A one-click Build plan waiting on a blocker can be given up here.
	if (phase.kind === "blocked" && canEdit && userId && snapshot?.buildRequested?.by === userId) {
		action = (
			<button
				className="btn btn-sm btn-outline shrink-0"
				onClick={() => {
					setActionError(undefined);
					cancelBuildRequest(room).then(
						() => build.reload(),
						error =>
							setActionError(
								sentenceCase(error instanceof Error ? error.message : "Cancel failed"),
							),
					);
				}}
				type="button"
			>
				Cancel build
			</button>
		);
	}
	if (activeBuild && canEdit && activeBuild.user === userId) {
		action = (
			<button
				aria-busy={stopping || undefined}
				aria-label="Stop build"
				className="btn btn-sm btn-ghost shrink-0"
				disabled={stopping}
				onClick={() => {
					setActionError(undefined);
					setStopping(true);
					stopBuild(room, activeBuild.id).then(
						() => build.reload(),
						error =>
							setActionError(sentenceCase(error instanceof Error ? error.message : "Stop failed")),
					).finally(() => setStopping(false));
				}}
				type="button"
			>
				{stopping
					? <LoaderIcon aria-hidden="true" className="build-card-spin" />
					: <span aria-hidden="true" className="build-card-stop" />}
				{stopping ? "Stopping" : "Stop"}
			</button>
		);
	}
	// A build that never started for want of an AI account of its starter's points its starter, and
	// only them, to where they add one.
	let unaccounted = [snapshot?.live?.rebuild, snapshot?.build].find(item =>
		item?.state === "failed" && noAiAccountRun(item.error)
	);
	if (!action && !activeBuild && unaccounted && unaccounted.user === userId) {
		action = (
			<a
				className="btn btn-sm btn-outline shrink-0"
				href={AI_ACCOUNTS_PATH}
				onClick={event => {
					if (
						event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
					) return;
					event.preventDefault();
					navigateTo(AI_ACCOUNTS_PATH);
				}}
			>
				Open AI accounts
			</a>
		);
	}
	// A pull request shared by several tasks lists its commits under the first of them.
	let listed = new Set<string>();
	// A built document lists the tasks its later rebuilds added under their own heading.
	let groups = phase.kind === "live" ? liveTaskGroups(tasks) : { first: tasks, since: [] };
	let noChange = phase.kind === "live" ? [...(snapshot?.live?.noChange ?? [])].toReversed() : [];
	let renderTask = (task: (typeof tasks)[number]) => {
		let report = reportFor(task);
		let url = report?.pullRequest?.url;
		let commits = url && !listed.has(url) ? pullRequestCommits(snapshot, url) : [];
		if (url) listed.add(url);
		let state = stateFor(task, report);
		// A task the build left unfinished says why where a blocked one shows its blocker.
		let stopped = phase.kind === "live" && outstanding.has(task.id) && !report?.blocker
				&& state === "blocked"
			? unfinishedReason(report)
			: undefined;
		let expanded = open[task.id] ?? taskStartsOpen(state, linked === task.id);
		let after = task.dependsOn.map(id => tasks.find(item => item.id === id)?.title ?? id);
		let number = report?.pullRequest && pullRequestNumber(report.pullRequest.url);
		return (
			<li className="build-task" id={`task-${task.id}`} key={task.id}>
				<TaskRow
					after={after}
					expanded={expanded}
					onToggle={() => setOpen(current => ({ ...current, [task.id]: !expanded }))}
					pullRequest={report?.pullRequest && {
						...report.pullRequest,
						number,
					}}
					blocker={report?.blocker}
					commits={commits}
					issue={issues?.tasks[task.id]}
					stopped={stopped}
					summary={report?.state === "completed" ? report.summary : undefined}
					noChange={report?.state === "completed" ? report.noChange : undefined}
					now={now}
					state={state}
					task={task}
				/>
			</li>
		);
	};

	return (
		<div className="build-view">
			<div className="build-view-content" data-build-view-scroll="">
				{phase.kind === "loading" && (
					<p className="build-status-line">
						{loadError
							? <span className="text-destructive-ink">{sentenceCase(loadError)}</span>
							: <span className="sr-only">Loading tasks</span>}
					</p>
				)}
				{card && (
					<div className="build-card">
						<p
							aria-live={phase.kind === "blocked" ? undefined : "polite"}
							className="build-card-top"
						>
							{card.glyph}
							<span className="build-card-title">{card.title}</span>
							{card.count && <span className="build-card-count">{card.count}</span>}
						</p>
						{(card.activity ?? card.detail) && (
							<p className="build-card-detail">
								{card.activity
									? (
										<span aria-live="polite" className="build-card-ticker" key={card.activity}>
											{card.activity}
										</span>
									)
									: typeof card.detail === "string"
									? <span className="build-card-ticker" key={card.detail}>{card.detail}</span>
									: card.detail}
							</p>
						)}
						{card.segments && card.segments.length > 0 && (
							<div aria-hidden="true" className="build-card-segments">
								{card.segments.map((state, index) => <span data-state={state} key={index} />)}
							</div>
						)}
						{issues?.parent && (
							<p className="build-card-issues m-0 mt-2 flex items-center gap-2 text-sm text-text-secondary">
								<span>
									{issues.current
										? "Tracked as GitHub issues"
										: "Earlier tasks tracked as GitHub issues"}
								</span>
								<a
									aria-label={`Parent issue #${issues.parent.number}`}
									className="build-task-pr"
									data-kind="issue"
									data-tooltip="Parent issue"
									href={issues.parent.url}
									rel="noreferrer"
									target="_blank"
								>
									<IssueOpenIcon />
									#{issues.parent.number}
								</a>
							</p>
						)}
						{(login || machine || from || action || issuesAction) && (
							<footer className="build-card-foot">
								{login && shown && (
									<span className="build-card-person">
										<Face decorative handle={login} size={18} titled={false} />
										<span className="build-card-person-name">
											{shown.user === userId ? "You" : `@${login}`}
										</span>
										{/* Outside the live region, so a ticking clock is not announced. */}
										{when && (
											<span className="build-card-quiet">
												{look.kind === "built" ? `built ${when}` : when}
											</span>
										)}
									</span>
								)}
								{machine && <MachineLabel machine={machine} />}
								{from && (
									<span className="build-card-source" title={shown?.planSource?.commit}>
										{from}
									</span>
								)}
								<span className="flex-1" />
								{issuesAction}
								{action}
							</footer>
						)}
					</div>
				)}
				{(build.needsAgent || snapshot?.localAgent === false && look.kind === "stopped") && (
					<div className="mt-3">
						<LocalAgentNote action={retryAction(look)} />
					</div>
				)}
				{phase.kind === "stopped" && returning && (
					<form
						className="build-return"
						onSubmit={event => {
							event.preventDefault();
							void returnToPlanning();
						}}
					>
						<label className="flex flex-col gap-1 text-sm">
							What needs to change?
							<textarea
								autoFocus
								className="field w-full"
								maxLength={2000}
								onChange={event => setReason(event.target.value)}
								required
								rows={3}
								value={reason}
							/>
						</label>
						<div className="flex gap-2">
							<button
								className="btn btn-md btn-primary"
								disabled={busy || !reason.trim()}
								type="submit"
							>
								Return to planning
							</button>
							<button
								className="btn btn-md btn-ghost"
								onClick={() => setReturning(false)}
								type="button"
							>
								Cancel
							</button>
						</div>
					</form>
				)}
				{assigning && exportable && (
					<IssuesForm
						assignees={assignees}
						busy={creating}
						onAssign={(task, value) => setAssignees(current => ({ ...current, [task]: value }))}
						onCancel={() => setAssigning(false)}
						onSubmit={() => void createAll()}
						people={people}
						tasks={unfinished}
						issues={issues}
					/>
				)}
				{issues?.problem && !issues.running && (
					<p className="m-0 mt-2 text-sm text-destructive-ink" role="alert">{issues.problem}</p>
				)}
				{build.rebuildError && (look.kind === "stale" || look.kind === "failed") && (
					build.rebuildNeedsAgent
						? (
							<div className="mt-3">
								<LocalAgentNote action={look.kind === "failed" ? "Retry" : "Build"} />
							</div>
						)
						: <p className="m-0 mt-2 text-sm text-destructive-ink">{build.rebuildError}</p>
				)}
				{actionError && (
					<p className="m-0 mt-2 text-sm text-destructive-ink" role="alert">{actionError}</p>
				)}
				{(phase.kind === "loading" && !loadError || breaking && !staleTasks) && (
					<div aria-hidden="true" className="build-skeleton">
						{[0, 1, 2, 3, 4].map(index => <span key={index} />)}
					</div>
				)}
				{showTasks && (
					<ol aria-label="Tasks" className="build-tasks" data-stale={staleTasks || undefined}>
						{groups.first.map(renderTask)}
					</ol>
				)}
				{showTasks && (groups.since.length > 0 || noChange.length > 0) && (
					<section aria-labelledby={sinceHeading} className="build-since">
						<h2 className="build-since-heading" id={sinceHeading}>Since first build</h2>
						<ol className="build-tasks">
							{groups.since.map(renderTask)}
							{/* A rebuild that needed no code change still says what it checked. */}
							{noChange.map(item => (
								<li className="build-no-change" key={item.buildId}>
									<CheckIcon aria-hidden="true" className="build-status-icon" size={12} />
									<span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
										No code change needed{" "}
										<span className="build-status-detail">{item.summary}</span>
									</span>
									<span className="build-elapsed">{ago(item.at, now)}</span>
								</li>
							))}
						</ol>
					</section>
				)}
			</div>
		</div>
	);
}

function TaskRow(
	{
		after,
		blocker,
		commits,
		expanded,
		issue,
		noChange,
		now,
		onToggle,
		pullRequest,
		state,
		stopped,
		summary,
		task,
	}: {
		after: string[];
		blocker?: string;
		commits: Array<{ sha: string; message: string; at: string }>;
		expanded: boolean;
		/** The GitHub issue this task was exported as, its assignee, or why that stopped short. */
		issue?: IssueExportSnapshot["tasks"][string];
		/** Why a finished task needed no code change, and what the agent checked to know. */
		noChange?: { reason: string; evidence: string };
		now: number;
		onToggle: () => void;
		pullRequest?: { url: string; state: "open" | "merged" | "closed"; number?: number };
		state: TaskState;
		/** Why a task the build left unfinished stopped. */
		stopped?: string;
		/** What a finished task did, in place of what finishing it required. */
		summary?: string;
		task: { id: string; title: string; goal: string; acceptance: string[] };
	},
) {
	let panel = useId();
	let reason = blocker && blockerText(blocker);
	return (
		<>
			<div className="build-task-head">
				<button
					aria-controls={panel}
					aria-expanded={expanded}
					aria-label={taskRowName(inlineText(task.title), state, !!noChange)}
					className="build-task-toggle"
					onClick={onToggle}
					type="button"
				>
					<span aria-hidden="true" className="build-task-dot" data-state={state} />
					<span className="build-task-title">
						<InlineMarkdown links={false} source={task.title} />
					</span>
				</button>
				{pullRequest && (
					<a
						aria-label={pullRequest.number
							? `Pull request #${pullRequest.number}, ${pullRequest.state}`
							: `Pull request, ${pullRequest.state}`}
						className="build-task-pr"
						data-state={pullRequest.state}
						href={pullRequest.url}
						rel="noreferrer"
						target="_blank"
					>
						{pullRequest.state === "merged"
							? <PullRequestMergedIcon />
							: pullRequest.state === "closed"
							? <PullRequestClosedIcon />
							: <PullRequestOpenIcon />}
						{pullRequest.number ? `#${pullRequest.number}` : "PR"}
					</a>
				)}
				{!pullRequest && noChange && (
					<span aria-hidden="true" className="build-task-pr" data-state="no-change">
						No change needed
					</span>
				)}
				{issue?.number && issue.url && (
					<a
						aria-label={`Issue #${issue.number}`}
						className="build-task-pr"
						data-kind="issue"
						data-tooltip="Issue"
						href={issue.url}
						rel="noreferrer"
						target="_blank"
					>
						<IssueOpenIcon />
						#{issue.number}
					</a>
				)}
			</div>
			<div className="build-task-fold" data-open={expanded || undefined} id={panel}>
				<div inert={!expanded}>
					<div className="build-task-detail">
						<p className="m-0">
							<InlineMarkdown source={task.goal} />
						</p>
						{issue?.assigned && issue.assignee && (
							<p className="m-0">Assigned to {assigneeName(issue.assignee)}</p>
						)}
						{issue?.problem && <p className="m-0 text-destructive-ink">{issue.problem}</p>}
						{summary && (
							<p className="build-task-summary">
								<InlineMarkdown source={summary} />
							</p>
						)}
						{noChange && (
							<>
								<p className="m-0">
									No change needed: <InlineMarkdown source={noChange.reason} />
								</p>
								<section aria-label="Evidence">
									<MessageMarkdown source={noChange.evidence} />
								</section>
							</>
						)}
						{!summary && task.acceptance.length > 0 && (
							<ul className="build-task-acceptance">
								{task.acceptance.map((item, index) => (
									<li key={index}>
										<InlineMarkdown source={item} />
									</li>
								))}
							</ul>
						)}
						{after.length > 0 && (
							<p className="m-0 text-text-tertiary">
								After {after.map((title, index) => (
									<Fragment key={index}>
										{index > 0 && ", "}
										<InlineMarkdown links={false} source={title} />
									</Fragment>
								))}
							</p>
						)}
						{reason && (
							<p className="build-task-blocker">
								{!blockerLabelled(reason) && "Blocked: "}
								<Linked text={reason} />
							</p>
						)}
						{stopped && (
							<p className="build-task-blocker">
								<Linked text={stopped} />
							</p>
						)}
						{pullRequest && commits.length > 0 && (
							<ul aria-label="Commits" className="build-task-commits">
								{commits.map(commit => (
									<li key={commit.sha}>
										<a
											className="build-task-sha"
											href={`${pullRequest.url}/commits/${commit.sha}`}
											rel="noreferrer"
											target="_blank"
										>
											{commit.sha.slice(0, 7)}
										</a>
										<span className="min-w-0 flex-1 truncate">{commit.message}</span>
										<span className="build-elapsed">{ago(commit.at, now)}</span>
									</li>
								))}
							</ul>
						)}
					</div>
				</div>
			</div>
		</>
	);
}

/** An agent's text with its links clickable, GitHub ones shortened to `owner/repo#N`. */
function Linked({ text }: { text: string }) {
	return linkParts(text).map((part, index) =>
		part.href
			? (
				<a href={part.href} key={index} rel="noreferrer" target="_blank">
					{part.text}
				</a>
			)
			: part.text
	);
}

function assigneeName(assignee: string): string {
	return assignee === "copilot" ? "Copilot" : `@${assignee}`;
}

/** Pick who each task's issue goes to before creating them; nobody is a valid choice. */
function IssuesForm(
	{ assignees, busy, issues, onAssign, onCancel, onSubmit, people, tasks }: {
		assignees: Record<string, string>;
		busy: boolean;
		issues?: IssueExportSnapshot;
		onAssign: (task: string, value: string) => void;
		onCancel: () => void;
		onSubmit: () => void;
		people: readonly string[];
		tasks: Array<{ id: string; title: string }>;
	},
) {
	let heading = useId();
	let creatable = tasks.filter(task => !issues?.tasks[task.id]?.number).length;
	return (
		<form
			aria-labelledby={heading}
			className="build-return"
			onSubmit={event => {
				event.preventDefault();
				onSubmit();
			}}
		>
			<p className="m-0 text-sm" id={heading}>
				{issues?.parent
					? "Finish the issues that are missing or couldn’t be assigned."
					: "Each task becomes a sub-issue of one issue for this document. Pick who picks each up."}
			</p>
			<ul className="m-0 flex list-none flex-col gap-2 p-0">
				{tasks.map(task => {
					let entry = issues?.tasks[task.id];
					let value = assignees[task.id] ?? "";
					// Option values are unique across every select on the page, the empty one included.
					let option = (choice: string) => `${task.id}/${choice}`;
					return (
						<li className="flex items-center gap-2 text-sm" key={task.id}>
							<span className="min-w-0 flex-1 truncate">
								{entry?.number ? `#${entry.number} ` : ""}
								<InlineMarkdown links={false} source={task.title} />
							</span>
							{entry?.assigned
								? <span className="build-card-quiet">{assigneeName(entry.assignee ?? "")}</span>
								: (
									<select
										aria-label={`Assignee for ${inlineText(task.title)}`}
										className="field"
										disabled={busy}
										onChange={event =>
											onAssign(task.id, event.target.value.slice(task.id.length + 1))}
										value={option(value)}
									>
										<option value={option("")}>Nobody yet</option>
										<option value={option("copilot")}>Copilot</option>
										{[...new Set([...people, ...(value && value !== "copilot" ? [value] : [])])]
											.map(
												login => <option key={login} value={option(login)}>@{login}</option>,
											)}
									</select>
								)}
						</li>
					);
				})}
			</ul>
			<div className="flex gap-2">
				<button
					aria-busy={busy || undefined}
					className="btn btn-md btn-primary"
					disabled={busy}
					type="submit"
				>
					{creatable > 0
						? `Create ${plural(creatable, "issue", "issues")}`
						: "Assign issues"}
				</button>
				<button className="btn btn-md btn-ghost" disabled={busy} onClick={onCancel} type="button">
					Cancel
				</button>
			</div>
		</form>
	);
}
