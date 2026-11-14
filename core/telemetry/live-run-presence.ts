import type { LiveRunLabelColor, LiveRunLabel, LiveRunPresenceWorkspace, RunPresenceDaemon, RunPresenceTerminal } from '../host/types';
export type { LiveRunLabelColor, LiveRunLabel, LiveRunPresenceWorkspace, RunPresenceDaemon, RunPresenceTerminal } from '../host/types';
import { writeOwnedJson } from "../machine/owned-file.mjs";
/**
 * Live run presence (task 530): while a test, QA or proof run is live, the
 * operator sees it where they work.
 *
 * - One terminal tab per workspace and selector, named for the run, following
 *   the run's live output. It prints the final status line when the run settles
 *   and then waits in the same tab for the next run of that selector, so Queue
 *   never leaves a stream of dead tabs behind.
 * - One coloured Paseo workspace label per live kind: "QA running" for a
 *   milestone QA run, "Testing" for a task test, proof or other live run.
 *
 * Both are projections of the live run set, never a source of truth: the
 * scheduler, the task record and the QA run row stay authoritative. A failed
 * terminal or label call is logged and never touches admission, scheduling, the
 * run or the task, and every pass re-reads the daemon's own inventory so a
 * restart restores live runs and clears runs that settled while Queue was down.
 *
 * What a tab follows is the run's live log: the host-run supervisor's own stdout
 * for a client-protocol run, and the per-run live log the validation and QA
 * supervisors tee beside their supervision files. Neither is the run's record;
 * the step logs and the result envelope stay authoritative.
 */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  HostRunInternalRecord,
  HostRunSettlement,
  ProjectQaRun,
  Task,
} from "../../shared/contracts";
import { hostRunSupervisorPaths } from "../host-runs/host-run-files";
import { projectValidationSupervisorPaths } from "../qa/project-validation-supervisor";
import { qaRunLiveOutputPath, qaRunRootPath } from "../qa/project-qa-supervision-files";
import { overdueHostRun, taskForHostRun } from "./ui-snapshot";
import { capPaseoTitle } from "../workspaces/workspace-title";

/** The two live kinds, each with the label the operator asked for (Tom, 2026-11-01: "Both"). */
export type LiveRunKind = "milestone_qa" | "test";
export const LIVE_RUN_LABELS: Readonly<Record<LiveRunKind, LiveRunLabel>> = {
  milestone_qa: { name: "QA running", color: "amber" },
  test: { name: "Testing", color: "violet" },
};
const TAB_PREFIX: Readonly<Record<LiveRunKind, string>> = {
  milestone_qa: "QA",
  test: "Testing",
};
/** How often the projection reconciles while the service runs. */
export const LIVE_RUN_PRESENCE_INTERVAL_MS = 2_000;
export const RUN_TERMINAL_POINTER_FORMAT = "queue.run-terminal";
/** The binary and script a tab runs; one spelling for the service and its tests. */
export const RUN_TERMINAL_FOLLOWER = {
  command: process.execPath,
  script: fileURLToPath(
    new URL("../../bin/queue-run-terminal.mjs", import.meta.url),
  ),
};

/** One live run's presence: where it shows, what it follows and under which label. */
export interface LiveRunPresenceTarget {
  /** Tab identity: a workspace directory and a selector, reused across runs. */
  key: string;
  /** The run this tab follows now; a relaunch of the same run starts a new session. */
  runId: string;
  sessionId: string;
  kind: LiveRunKind;
  selector: string;
  tabName: string;
  /** The workspace the run shows in, or null while its directory has no entry yet. */
  workspaceId: string | null;
  /** The checkout to open as a workspace when `workspaceId` is null. */
  openDirectory: string | null;
  cwd: string;
  outputPaths: string[];
  label: LiveRunLabel;
}

/** What the service writes for one tab; the follower renders it and nothing else reads it. */
export interface RunTerminalPointer {
  format: typeof RUN_TERMINAL_POINTER_FORMAT;
  version: 1;
  key: string;
  /** The workspace the tab lives in, or an empty string while it is still to open. */
  workspaceId: string;
  tabName: string;
  sessionId: string;
  runId: string;
  outputs: string[];
  /** The service's final status line, null while the run is live. */
  settledLine: string | null;
  updatedAt: string;
  /** The run session for which the daemon successfully opened a follower tab. */
  followerStartedSessionId?: string;
  /** The run session whose missing follower has already been logged. */
  followerExitLoggedSessionId?: string;
}

export interface LiveRunPresenceInput {
  runs: readonly HostRunInternalRecord[];
  tasks: readonly Task[];
  qaRun: (id: string) => ProjectQaRun | null;
  workspaces: readonly LiveRunPresenceWorkspace[];
  /** The Queue data directory that owns the validation and milestone-QA run roots. */
  dataDir: string;
  /** The host-run state root that owns a client-protocol run's retained output. */
  stateDir: string;
  nowMs: number;
}

const cleanSelector = (selector: string) =>
  selector.replace(/\s+/g, " ").trim();
export const liveRunTabName = (kind: LiveRunKind, selector: string) =>
  capPaseoTitle(`${TAB_PREFIX[kind]} · ${cleanSelector(selector) || "run"}`);
/**
 * One tab per workspace directory and selector. The directory, not the workspace
 * id, is the identity: a milestone QA run may open its workspace on first sight,
 * and the tab it follows must be the same file before and after that.
 */
export const liveRunPresenceKey = (
  kind: LiveRunKind,
  workspaceDirectory: string,
  selector: string,
) =>
  `${kind}|${resolve(workspaceDirectory)}|${cleanSelector(selector)}`;

/**
 * The live runs that can be shown, one target per workspace and selector. Only a
 * launched run has live output to follow, so a queued run waits for its launch;
 * the oldest of two runs sharing one tab stays, so the choice never flickers
 * between passes.
 */
export function liveRunPresenceTargets(
  input: LiveRunPresenceInput,
): LiveRunPresenceTarget[] {
  const byId = new Map(
    input.workspaces.map((workspace) => [workspace.id, workspace]),
  );
  const byDirectory = new Map<string, LiveRunPresenceWorkspace>();
  for (const workspace of input.workspaces)
    if (workspace.directory)
      byDirectory.set(resolve(workspace.directory), workspace);
  // A Queue-submitted validation run works in its own isolated checkout, outside
  // every workspace, so its task's recorded host run — not a directory — is what
  // places it in the task workspace.
  const validationByRun = new Map<
    string,
    {
      task: Task;
      validation: NonNullable<Task["resolution"]["projectValidation"]>;
    }
  >();
  for (const task of input.tasks) {
    const validation = task.resolution.projectValidation;
    if (validation?.hostRunId)
      validationByRun.set(validation.hostRunId, { task, validation });
  }
  const chosen = new Map<string, LiveRunPresenceTarget>();
  const ordered = [...input.runs]
    .filter(
      (run) => run.state === "running" && !overdueHostRun(run, input.nowMs),
    )
    .sort(
      (left, right) =>
        Date.parse(left.submittedAt) - Date.parse(right.submittedAt) ||
        left.id.localeCompare(right.id),
    );
  for (const run of ordered) {
    const qa = input.qaRun(run.id);
    const kind: LiveRunKind = qa ? "milestone_qa" : "test";
    const selector = qa?.selector ?? run.selector;
    const recorded = qa ? undefined : validationByRun.get(run.id);
    const task =
      recorded?.task ?? (qa ? undefined : taskForHostRun(input.tasks, run));
    // A task run belongs in the task's workspace; a milestone QA run and any run
    // without a task belong where the registered checkout is open.
    const checkout = resolve(run.repository.path);
    const workspace = qa
      ? byDirectory.get(checkout)
      : ((task?.workspaceId ? byId.get(task.workspaceId) : undefined) ??
        byDirectory.get(resolve(task?.directory ?? run.repository.path)));
    // Milestone QA runs on the project's main checkout. When the operator's
    // sidebar has no workspace on that checkout, Queue opens one on it — an entry
    // only, never a worktree — and it stays afterwards (Tom, 2026-11-01).
    const openDirectory = !workspace && qa ? checkout : null;
    if (!workspace?.directory && !openDirectory) continue;
    const outputPaths = qa
      ? [
          qaRunLiveOutputPath(
            qaRunRootPath(input.dataDir, qa.submittedKey ?? qa.key),
            qa.id,
          ),
        ]
      : recorded
        ? [
            projectValidationSupervisorPaths(input.dataDir, run.id)
              .liveOutputPath,
          ]
        : clientRunOutputPaths(input.stateDir, run.id);
    const cwd = workspace?.directory ?? openDirectory!;
    const key = liveRunPresenceKey(kind, cwd, selector);
    if (chosen.has(key)) continue;
    chosen.set(key, {
      key,
      runId: run.id,
      sessionId: `${run.id}@${run.launchedAt ?? run.submittedAt}`,
      kind,
      selector: cleanSelector(selector),
      tabName: liveRunTabName(kind, selector),
      workspaceId: workspace?.id ?? null,
      openDirectory,
      cwd,
      outputPaths,
      label: LIVE_RUN_LABELS[kind],
    });
  }
  return [...chosen.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
}

/**
 * A client-protocol run's own retained streams, which its supervisor writes as
 * the command runs. Both are followed so a failure reported on stderr is as
 * visible as a progress line on stdout.
 */
function clientRunOutputPaths(stateDir: string, runId: string): string[] {
  const paths = hostRunSupervisorPaths(stateDir, runId);
  return [paths.stdoutPath, paths.stderrPath];
}

const QA_STATE_TEXT: Readonly<Record<ProjectQaRun["state"], string>> = {
  queued: "queued",
  running: "running",
  passed: "passed",
  failed: "failed",
  hold: "held",
  timed_out: "timed out",
  cancelled: "cancelled",
  lost: "lost",
};
const VALIDATION_STATE_TEXT: Readonly<
  Record<"running" | "passed" | "refused" | "hold" | "superseded", string>
> = {
  running: "running",
  passed: "passed",
  refused: "refused",
  hold: "held",
  superseded: "superseded",
};
const SETTLEMENT_TEXT: Readonly<Record<HostRunSettlement["outcome"], string>> =
  {
    passed: "passed",
    failed: "failed",
    timed_out: "timed out",
    cancelled: "cancelled",
    lost: "lost",
    capacity_timeout: "never started (capacity deadline expired)",
  };

export function formatRunDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60),
    rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** `QA · qa:stage:rust · passed (exit 0) in 3m 12s`, the line a settled tab keeps. */
export function liveRunSettlementLine(
  tabName: string,
  status: string,
  exitCode: number | null,
  durationMs: number | null,
): string {
  return `${tabName} · ${status}${exitCode === null ? "" : ` (exit ${exitCode})`}${durationMs === null ? "" : ` in ${formatRunDuration(durationMs)}`}`;
}

export interface LiveRunPresenceOptions {
  dataDir: string;
  stateDir: string;
  runs: () => HostRunInternalRecord[];
  /** One durable host-run row, settled or live, for naming what a run ended as. */
  settledRun: (id: string) => HostRunInternalRecord | null;
  tasks: () => Task[];
  qaRun: (id: string) => ProjectQaRun | null;
  /** The daemon, or null while Queue has no usable Paseo connection. */
  daemon: () => RunPresenceDaemon | null;
  follower?: { command: string; script: string };
  log?: (message: string) => void;
  now?: () => number;
}

/** What one pass has already asked the daemon, so it never repeats itself. */
interface PassState {
  /** Terminals per workspace, read once per pass. */
  terminals: Map<string, Array<{ id: string; name: string }> | null>;
  /** The workspace id opened for a directory this pass, or null when opening failed. */
  opened: Map<string, string | null>;
  /** Labels a workspace opened this pass needs, since no inventory listed it. */
  openedLabels: Map<string, Set<string>>;
}

/**
 * Reconciles the operator's tabs and labels against the live run set. Every
 * daemon call is best effort: a failure is logged and the next pass retries, and
 * nothing here can reject a run, hold a slot or change a task.
 */
export class LiveRunPresence {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private passes = 0;
  /** True once a pass with no live run completed against a readable inventory. */
  private auditedWhileIdle = false;
  private readonly pointerDir: string;
  private readonly follower: { command: string; script: string };
  private readonly log: (message: string) => void;
  private readonly now: () => number;

  constructor(private readonly options: LiveRunPresenceOptions) {
    this.pointerDir = join(options.dataDir, "run-terminal");
    this.follower = options.follower ?? RUN_TERMINAL_FOLLOWER;
    this.log =
      options.log ??
      ((message) =>
        console.error("Nucleus live-run presence:", message));
    this.now = options.now ?? Date.now;
  }

  start(intervalMs = LIVE_RUN_PRESENCE_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.reconcile();
    }, intervalMs);
    this.timer.unref?.();
    void this.reconcile();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass, serialized: a slow daemon never stacks passes on itself. */
  reconcile(): Promise<void> {
    this.inFlight ??= this.runPass()
      .catch((error) => {
        this.log(
          `projection pass failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** The pointer file one tab's follower polls. */
  pointerPath(key: string): string {
    return join(
      this.pointerDir,
      `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`,
    );
  }

  private async runPass(): Promise<void> {
    const runs = this.options.runs();
    const liveRunIds = new Set(
      runs.filter((run) => run.state !== "settled").map((run) => run.id),
    );
    if (liveRunIds.size) this.auditedWhileIdle = false;
    // A tab's final status line is written from Queue's own records, so a run that
    // settled while Queue was down still stops following even with no daemon.
    this.settleAbandonedPointers(liveRunIds);
    const daemon = this.options.daemon();
    if (!daemon) return;
    // With no live run, one completed audit is all that is left to do: it clears a
    // label a run left behind (a restart is the ordinary case). Asking the daemon
    // again every pass until the next run would be an idle 0.5 requests a second
    // forever, so a quiet service stays quiet.
    if (!liveRunIds.size && this.auditedWhileIdle) return;
    this.passes++;
    let workspaces: LiveRunPresenceWorkspace[];
    try {
      workspaces = await daemon.workspaces();
    } catch (error) {
      // Without the daemon's own inventory the projection cannot tell a live
      // workspace from a settled one, so it places nothing and clears nothing.
      this.log(`workspace inventory is unavailable: ${errorMessage(error)}`);
      return;
    }
    const targets = liveRunPresenceTargets({
      runs,
      tasks: runs.length ? this.options.tasks() : [],
      qaRun: this.options.qaRun,
      workspaces,
      dataDir: this.options.dataDir,
      stateDir: this.options.stateDir,
      nowMs: this.now(),
    });
    this.auditedWhileIdle = liveRunIds.size === 0;
    const pass: PassState = {
      terminals: new Map(),
      opened: new Map(),
      openedLabels: new Map(),
    };
    for (const target of targets)
      await this.openTerminal(daemon, target, pass);
    await this.reconcileLabels(daemon, workspaces, targets, pass);
  }

  /**
   * The workspace a target shows in, opening the project's own entry on the
   * registered checkout when nothing has it open. One open per directory per
   * pass, and a failure is this projection's problem alone: the tab waits for
   * the next pass instead.
   */
  private async workspaceFor(
    daemon: RunPresenceDaemon,
    target: LiveRunPresenceTarget,
    pass: PassState,
  ): Promise<string | null> {
    if (target.workspaceId) return target.workspaceId;
    const directory = target.openDirectory;
    if (!directory) return null;
    if (!pass.opened.has(directory)) {
      let opened: string | null = null;
      try {
        const workspace = await daemon.openWorkspace({
          directory,
          requestId: `queue-run-workspace:${eventId(directory)}:${this.passes}`,
        });
        opened = workspace.id;
        // A sidebar entry this projection needed is the operator's once it exists,
        // so it is never archived with the run (Tom, 2026-11-01).
        this.log(`opened the Paseo workspace for ${directory}`);
      } catch (error) {
        this.log(
          `workspace for ${directory} could not be opened: ${errorMessage(error)}`,
        );
      }
      pass.opened.set(directory, opened);
    }
    return pass.opened.get(directory) ?? null;
  }

  /** Open the run's tab, or keep the one this workspace and selector already has. */
  private async openTerminal(
    daemon: RunPresenceDaemon,
    target: LiveRunPresenceTarget,
    pass: PassState,
  ): Promise<void> {
    const pointerPath = this.pointerPath(target.key);
    const previousPointer = readPointer(pointerPath);
    const pointer: RunTerminalPointer = {
      format: RUN_TERMINAL_POINTER_FORMAT,
      version: 1,
      key: target.key,
      workspaceId: target.workspaceId ?? "",
      tabName: target.tabName,
      sessionId: target.sessionId,
      runId: target.runId,
      outputs: target.outputPaths,
      settledLine: null,
      updatedAt: new Date(this.now()).toISOString(),
      ...(previousPointer?.sessionId === target.sessionId &&
      previousPointer.followerStartedSessionId
        ? { followerStartedSessionId: previousPointer.followerStartedSessionId }
        : {}),
      ...(previousPointer?.sessionId === target.sessionId &&
      previousPointer.followerExitLoggedSessionId
        ? {
            followerExitLoggedSessionId:
              previousPointer.followerExitLoggedSessionId,
          }
        : {}),
    };
    this.writePointer(pointerPath, pointer);
    const workspaceId = await this.workspaceFor(daemon, target, pass);
    if (!workspaceId) return;
    // A workspace this pass opened is not in the inventory it read, so its label
    // is assigned from what the target asked for rather than from a stale list.
    if (!target.workspaceId) {
      const names = pass.openedLabels.get(workspaceId) ?? new Set<string>();
      names.add(target.label.name);
      pass.openedLabels.set(workspaceId, names);
    }
    if (!pass.terminals.has(workspaceId)) {
      try {
        pass.terminals.set(
          workspaceId,
          await daemon.listTerminals(workspaceId),
        );
      } catch (error) {
        this.log(
          `terminals of ${workspaceId} could not be listed: ${errorMessage(error)}`,
        );
        pass.terminals.set(workspaceId, null);
      }
    }
    const existing = pass.terminals.get(workspaceId);
    // One tab per workspace and selector: the tab of this name already follows
    // this pointer, so a run that settles and the next one that starts share it.
    if (existing?.some((terminal) => terminal.name === target.tabName)) return;
    if (pointer.followerStartedSessionId === target.sessionId) {
      // An unreadable inventory is not evidence the tab exited. Keep the
      // successful launch marker and wait for a readable pass before deciding.
      if (!existing) return;
      if (pointer.followerExitLoggedSessionId !== target.sessionId) {
        this.log(
          `terminal ${target.tabName} exited during run ${target.runId}; it will not be reopened for this session`,
        );
        this.writePointer(pointerPath, {
          ...pointer,
          followerExitLoggedSessionId: target.sessionId,
        });
      }
      return;
    }
    try {
      const created = await daemon.createTerminal({
        workspaceId,
        cwd: target.cwd,
        name: target.tabName,
        command: "/usr/bin/env",
        args: [
          "ELECTRON_RUN_AS_NODE=1",
          this.follower.command,
          this.follower.script,
          pointerPath,
        ],
        requestId: `queue-run-terminal:${eventId(target.key)}:${eventId(target.sessionId)}`,
      });
      if (existing) existing.push({ id: created.id, name: target.tabName });
      this.writePointer(pointerPath, {
        ...pointer,
        followerStartedSessionId: target.sessionId,
      });
    } catch (error) {
      this.log(
        `terminal ${target.tabName} could not be opened in ${workspaceId}: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Keep each live workspace labelled with its kind, and clear this projection's
   * labels everywhere else. Reading assignments from the daemon's own workspace
   * inventory is what clears a label for a run that settled while Queue was down.
   */
  private async reconcileLabels(
    daemon: RunPresenceDaemon,
    workspaces: readonly LiveRunPresenceWorkspace[],
    targets: readonly LiveRunPresenceTarget[],
    pass: PassState,
  ): Promise<void> {
    const wanted = new Map<string, Set<string>>();
    for (const target of targets) {
      if (!target.workspaceId) continue;
      const names = wanted.get(target.workspaceId) ?? new Set<string>();
      names.add(target.label.name);
      wanted.set(target.workspaceId, names);
    }
    const ensured = new Set<string>();
    const assign = async (
      workspaceId: string,
      label: LiveRunLabel,
      wanted: boolean,
    ) => {
      if (wanted && !ensured.has(label.name)) {
        ensured.add(label.name);
        try {
          await daemon.ensureWorkspaceLabel(label);
        } catch (error) {
          this.log(
            `label ${label.name} could not be defined: ${errorMessage(error)}`,
          );
        }
      }
      try {
        await daemon.assignWorkspaceLabel({
          workspaceId,
          label,
          assigned: wanted,
          requestId: `queue-run-label:${eventId(workspaceId)}:${eventId(label.name)}:${wanted ? "on" : "off"}:${this.passes}`,
        });
      } catch (error) {
        this.log(
          `label ${label.name} ${wanted ? "assignment" : "clear"} failed in ${workspaceId}: ${errorMessage(error)}`,
        );
      }
    };
    for (const workspace of workspaces) {
      const desired = wanted.get(workspace.id) ?? new Set<string>();
      for (const label of Object.values(LIVE_RUN_LABELS)) {
        const assigned = workspace.labels.includes(label.name);
        const want = desired.has(label.name);
        if (assigned === want) continue;
        await assign(workspace.id, label, want);
      }
    }
    // A workspace opened in this pass was not in the inventory read above.
    for (const [workspaceId, names] of pass.openedLabels) {
      for (const label of Object.values(LIVE_RUN_LABELS)) {
        if (names.has(label.name)) await assign(workspaceId, label, true);
      }
    }
  }

  /**
   * A pointer whose run is no longer live names what that run settled as, so a
   * tab left following a run Queue stopped watching — a service restart is the
   * ordinary case — stops at the run's own final line instead of a static file.
   */
  private settleAbandonedPointers(liveRunIds: ReadonlySet<string>): void {
    let names: string[];
    try {
      names = readdirSync(this.pointerDir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.pointerDir, name);
      const pointer = readPointer(path);
      if (
        !pointer ||
        pointer.settledLine !== null ||
        liveRunIds.has(pointer.runId)
      )
        continue;
      this.writePointer(path, {
        ...pointer,
        settledLine: this.settlementLine(pointer.runId, pointer.tabName),
        updatedAt: new Date(this.now()).toISOString(),
      });
    }
  }

  /** The final status line for one run, from its own durable record. */
  settlementLine(runId: string, tabName: string): string {
    const settled = this.options.settledRun(runId);
    const byHost = () =>
      settled?.settlement
        ? liveRunSettlementLine(
            tabName,
            SETTLEMENT_TEXT[settled.settlement.outcome],
            settled.settlement.result?.exitCode ?? null,
            settled.settlement.result?.wallMs ?? null,
          )
        : null;
    const qa = this.options.qaRun(runId);
    if (qa) {
      // A QA row that still says running while its host run is gone is between the
      // run's settlement and its own: name the settlement we have, never "running".
      if (qa.state !== "running")
        return liveRunSettlementLine(
          tabName,
          QA_STATE_TEXT[qa.state],
          qa.exitCode,
          qa.durationMs,
        );
      return byHost() ?? `${tabName} · no longer live`;
    }
    // A validation row settles before its host run does, so its own state names the
    // verdict; otherwise the run's settlement is the only honest answer.
    const validation = this.options
      .tasks()
      .find((task) => task.resolution.projectValidation?.hostRunId === runId)
      ?.resolution.projectValidation;
    const validationLine =
      validation && validation.state !== "running"
        ? liveRunSettlementLine(
            tabName,
            VALIDATION_STATE_TEXT[validation.state],
            validation.exitCode,
            validation.durationMs,
          )
        : null;
    return validationLine ?? byHost() ?? `${tabName} · no longer live`;
  }

  /**
   * Write a pointer only when what it says changes, so a steady pass over a live
   * run costs no write; the stamp moves with the content it stamps.
   */
  private writePointer(path: string, pointer: RunTerminalPointer): void {
    const current = readPointer(path);
    if (current && samePointer(current, pointer)) return;
    const stamped = { ...pointer, updatedAt: new Date(this.now()).toISOString() };
    try {
      mkdirSync(this.pointerDir, { recursive: true, mode: 0o700 });
      writeOwnedJson(path, stamped);
    } catch (error) {
      this.log(
        `run terminal pointer ${path} could not be written: ${errorMessage(error)}`,
      );
    }
  }
}

/** Every field a follower reads, without the stamp that says when it was read. */
function samePointer(left: RunTerminalPointer, right: RunTerminalPointer): boolean {
  return (
    left.format === right.format &&
    left.version === right.version &&
    left.key === right.key &&
    left.workspaceId === right.workspaceId &&
    left.tabName === right.tabName &&
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.settledLine === right.settledLine &&
    left.outputs.length === right.outputs.length &&
    left.outputs.every((path, index) => path === right.outputs[index]) &&
    left.followerStartedSessionId === right.followerStartedSessionId &&
    left.followerExitLoggedSessionId === right.followerExitLoggedSessionId
  );
}

const eventId = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function readPointer(path: string): RunTerminalPointer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const candidate = parsed as Partial<RunTerminalPointer> | null;
  return candidate &&
    candidate.format === RUN_TERMINAL_POINTER_FORMAT &&
    candidate.version === 1 &&
    typeof candidate.key === "string" &&
    typeof candidate.tabName === "string" &&
    typeof candidate.runId === "string" &&
    typeof candidate.sessionId === "string"
    ? (candidate as RunTerminalPointer)
    : null;
}
