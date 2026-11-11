import {
  QA_SUPERVISION_SCHEMA,
  QA_SUPERVISION_SCHEMA_VERSION,
  qaSupervisionPlanSchema,
  qaSupervisionPaths,
  writeHostRunResult,
  readQaCancelRequest,
  writeQaSupervisionPlan,
  writeQaSupervision,
  qaStepLogPaths,
  qaRunLiveOutputPath,
  writeQaStepLog,
  type ProjectQaWorktreeHooks,
  type QaSupervisionPlan,
  type QaCancelRequest,
  type QaSupervisionState,
} from "./project-qa-supervision-files";
export * from "./project-qa-supervision-files";
import { PROJECT_QA_FAILURES_BYTES, StreamingTapFailures, boundedFailureLocation, redactFailureIndex, failureCoverageDetail, appendFailuresLog } from "./project-qa-tap-failures";
export { StreamingTapFailures, PROJECT_QA_FAILURES_BYTES } from "./project-qa-tap-failures";

import { redactTokenBuffer } from "../machine/token-redactor";
import { writeOwnedJson } from "../machine/owned-file.mjs";
/**
 * Milestone QA supervision (task 114): the setup, QA and teardown pipeline runs
 * in a detached supervisor process that outlives the Queue service, and records
 * each step durably as it settles.
 *
 * Queue rolls its service on every merge to its own repository. Until this
 * landed, the pipeline ran inside the service process, so a roll mid-run lost
 * every in-memory step: consumer-b's runs 7b323d2d and 5181dfcb settled as
 * `hold` with `steps: []` and `durationMs: 0` even though setup had completed.
 * Now the service claims the run, writes one per-run plan under the QA root, and
 * spawns this supervisor detached. The supervisor owns the worktree, the hooks,
 * the command and the cleanup, and writes a per-run supervision file under the
 * QA root after every state change:
 *
 * - the run's pid and its random identity token, so a restarted service can
 *   prove whether the recorded pid still names this supervisor (a pid alone is
 *   recycled, and a start time is not precise enough; `process-identity.ts`
 *   explains the token);
 * - `inFlight`, the step currently running, so a supervisor proven dead names
 *   the step in flight rather than the run losing its shape;
 * - `steps`, each with its command, exit code, signal, timeout and the head and
 *   tail of its own stdout and stderr;
 * - the final result, when it settles.
 *
 * A restarted service re-attaches by reading that file: a live supervisor keeps
 * the run running and the new service waits for it, and the run is reconciled as
 * lost only when the supervisor is proven dead. The supervisor never writes to
 * the Queue store; the service owns every record and reconciles the run with
 * Queue's host scheduler by run ID, so re-attach needs no state carried in memory.
 */
import { existsSync, readFileSync, readlinkSync, realpathSync } from "node:fs";

import { lstat, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { cwdMapFromLsof } from "../workspaces/worktree-validation";

import {
  hostRunResultSchema,
  PROJECT_QA_LOG_WRITE_ERRORS_MAX,
  type HostRunCpuCoverage,
  type HostRunEscapedDescendant,
  type HostRunResult,
  type ProjectQaFailureIndex,
  type ProjectQaLogWriteError,
  type ProjectQaRun,
  type ProjectQaStage,
  type ProjectQaStep,
  type ProjectQaStepName,
} from "../../shared/contracts";
import { executeHookProgram, gitRaw, minimalHookEnvironment, type ExecutionOutcome } from "../hooks/hooks";
import { withRunTemporaryDirectory } from "../workspaces/run-scratch";
import { FAILURE_FIRST_RETENTION_NOTE, boundedHeadTail, streamTruncation, type StreamTruncation } from "../machine/output-retention";
import { boundSidecarCoverage, hostRunCpuCoverageSidecar, type HostRunCpuCoverageSidecar } from "../host-runs/host-run-cpu-coverage";
import { findGitWorktreeAdd, processCommandLine } from "../machine/process-identity";
import { parseWorktreeList, repoCommonDir } from "../workspaces/workspace-allocation";
import { ProcessTreeCpuSampler, processStartIdentityLiveness, type ProcessTreeCpu } from "../machine/process-group";
import { hostRunProcessStartIdentity } from "../machine/start-identity";
import { defaultHostRunStateDir } from "../host-runs/host-run-files";
import { HOST_RUN_TOKEN_GRACE_MS } from "../host-runs/host-run-endpoint-types";
import { hostRunLaunchEnvironment } from "../host-runs/host-run-wire";
import { issueHostRunToken } from "../host-runs/host-run-token";
import { assertCheckoutAvailable } from "../workspaces/checkout-volume";
import { openLiveOutputLog } from "../machine/live-output";

/** Bytes of each stream kept as one step's own head and tail on the run record. */
export const PROJECT_QA_STEP_OUTPUT_BYTES = 512;
/** How often a live supervisor refreshes its heartbeat in the supervision file. */
export const SUPERVISOR_HEARTBEAT_MS = 2_000;

/**
 * The Queue-internal CPU reason for a settling result: only from this run's
 * private sidecar naming the same run, epoch, step and cpuMs. The step is the
 * one whose process group the result names in this run's own supervision
 * state; without that state the reason is absent.
 */
export function qaSupervisionCpuCoverage(runId: string, state: QaSupervisionState | null, hostResult: HostRunResult | null, sidecar: unknown): HostRunCpuCoverage | undefined {
  if (!hostResult || hostResult.runId !== runId || state?.runId !== runId) return undefined;
  const step = state.steps.find(entry => entry.processGroupId === hostResult.pgid)?.name;
  return boundSidecarCoverage(sidecar, { runId, epoch: hostResult.epoch, ...(step ? { step } : {}), cpuMs: hostResult.cpuMs });
}

export { supervisorLiveness, supervisorLivenessAsync } from "../machine/supervisor-liveness";
export type { SupervisorLiveness, SupervisorLivenessProbes } from "../machine/supervisor-liveness";

/**
 * The bounded head and tail of one stream, so one step cannot evict another's
 * error. A stream the executor's cap cut keeps a marker and its byte counts in
 * both excerpts (task 388), so neither one reads as complete output.
 */
export function streamHeadTail(buffer: Buffer, limit = PROJECT_QA_STEP_OUTPUT_BYTES, truncation?: StreamTruncation | null, shapeNote?: string): { head: string; tail: string } {
  return boundedHeadTail(buffer, limit, truncation, shapeNote);
}

/** One command's whole output, stdout before stderr. */
export function executionOutput(execution: { stdout: Buffer; stderr: Buffer; terminationError?: string | null; processGroupEmpty?: boolean | null }): string {
  const output = Buffer.concat([execution.stdout, execution.stderr]).toString("utf8");
  const termination = execution.terminationError
    ?? (execution.processGroupEmpty === false ? "The recorded process group was not empty after termination." : "");
  return [output, termination].filter(Boolean).join(`${output ? "\n" : ""}`);
}

/** True when an absolute path sits inside one of the roots (string comparison only). */
function pathWithinRoots(candidate: string, roots: readonly string[]): boolean {
  return roots.some(root => candidate === root || candidate.startsWith(root.endsWith("/") ? root : `${root}/`));
}

/**
 * True when an escaped descendant is rooted in the QA worktree. A cwd inside
 * the checkout or run root proves it, as does an absolute argv containing a
 * root. A *known-outside* cwd disproves rooting outright. Only when the cwd
 * is unreadable does a relative script argv naming a file inside the roots
 * count: the pid is already proven by start identity to be this run's own
 * descendant, so `node bin/queue-service.mjs` with no readable cwd is still
 * provably ours when that script exists in the checkout.
 */
export function escapeeRootedInWorktree(
  process: { cwd: string | null; command: string | null; argv?: readonly string[] | null },
  roots: { checkoutPath: string; runRoot: string },
): boolean {
  const list = [roots.checkoutPath, roots.runRoot];
  if (process.cwd && pathWithinRoots(process.cwd, list)) return true;
  if (process.command && list.some(root => process.command!.includes(root))) return true;
  if (process.cwd !== null) return false;
  for (const token of (process.argv ?? []).slice(0, 12)) {
    if (!token || token.startsWith("-") || isAbsolute(token) || token.includes("://")) continue;
    if (!/\.(mjs|cjs|js|ts|sh)$/.test(token)) continue;
    for (const root of list) {
      const resolved = join(root, token);
      if (pathWithinRoots(resolved, [root]) && existsSync(resolved)) return true;
    }
  }
  return false;
}

function readEscapeeCwd(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try { return readlinkSync(`/proc/${pid}/cwd`, "utf8"); }
  catch { return null; }
}

/** Read every escapee cwd in one OS pass (one lsof on macOS, /proc on Linux). */
function readEscapeeCwds(pids: readonly number[]): Map<number, string | null> {
  const found = new Map<number, string | null>();
  if (!pids.length) return found;
  if (process.platform === "linux") {
    for (const pid of pids) found.set(pid, readEscapeeCwd(pid));
    return found;
  }
  if (process.platform === "darwin") {
    const map = cwdMapFromLsof(pids as number[], spawnSync("lsof", ["-a", "-d", "cwd", "-Fn", "-p", pids.join(",")], {
      encoding: "utf8", timeout: 5_000,
    }));
    for (const pid of pids) {
      const state = map?.get(pid);
      found.set(pid, state?.state === "read" ? state.path : null);
    }
    return found;
  }
  for (const pid of pids) found.set(pid, null);
  return found;
}

/** The escapee's argv: exact from /proc on Linux, best-effort tokens elsewhere. */
function readEscapeeArgv(pid: number): string[] | null {
  if (process.platform === "linux") {
    try {
      const parts = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(part => part !== "");
      return parts.length ? parts : null;
    } catch { return null; }
  }
  const line = processCommandLine(pid);
  if (!line) return null;
  const tokens = line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!tokens) return null;
  return tokens.map(token => token.replace(/^(["'])(.*)\1$/, "$2")).filter(token => token !== "");
}

export interface QaEscapeeReapProbes {
  liveness?(pid: number, startIdentity: string): "alive" | "dead" | "unknown";
  cwd?(pid: number): string | null;
  command?(pid: number): string | null;
  argv?(pid: number): readonly string[] | null;
  signal?(pid: number, signal: NodeJS.Signals): void;
  sleep?(ms: number): Promise<void>;
}

export interface QaEscapeeReapResult {
  reaped: Array<{ pid: number; startIdentity: string }>;
  held: Array<{ pid: number; startIdentity: string; reason: string }>;
}

const reapSleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

/**
 * Task 191: after the QA step and teardown, terminate the run's own escaped
 * descendants that are rooted in its Queue-owned QA worktree (by cwd or
 * argv), so the scheduler can prove them dead and release capacity. Every
 * signal names the exact pid only after its recorded start identity is proven
 * alive — never a command pattern — and the identity is re-proven before the
 * SIGKILL escalation. Escapees outside the worktree, unreadable ones and
 * survivors keep today's hold: they stay recorded and are returned as held.
 */
export async function reapQaWorktreeEscapees(
  escaped: ReadonlyArray<HostRunEscapedDescendant>,
  roots: { checkoutPath: string; runRoot: string },
  options: { graceMs?: number } & QaEscapeeReapProbes = {},
): Promise<QaEscapeeReapResult> {
  const graceMs = Math.max(0, options.graceMs ?? 5_000);
  const liveness = options.liveness ?? processStartIdentityLiveness;
  const readCommand = options.command ?? (pid => processCommandLine(pid));
  const readArgv = options.argv ?? readEscapeeArgv;
  const signal = options.signal ?? ((pid, sig) => { process.kill(pid, sig); });
  const sleep = options.sleep ?? reapSleep;
  const reaped: QaEscapeeReapResult["reaped"] = [];
  const held: QaEscapeeReapResult["held"] = [];
  const seen = new Set<string>();
  const live: HostRunEscapedDescendant[] = [];
  for (const descendant of escaped) {
    const key = `${descendant.pid}:${descendant.startIdentity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (liveness(descendant.pid, descendant.startIdentity) === "alive") live.push(descendant);
  }
  // One OS pass for every cwd (a single lsof on macOS), unless tests inject
  // per-pid reads.
  const cwdBatch: Map<number, string | null> = options.cwd ? new Map() : readEscapeeCwds(live.map(descendant => descendant.pid));
  for (const descendant of live) {
    const cwd = options.cwd ? options.cwd(descendant.pid) : (cwdBatch.get(descendant.pid) ?? null);
    const command = readCommand(descendant.pid);
    const argv = readArgv(descendant.pid);
    if (liveness(descendant.pid, descendant.startIdentity) !== "alive") continue;
    if (!cwd && !command && !(argv?.length)) {
      held.push({ pid: descendant.pid, startIdentity: descendant.startIdentity, reason: "location unreadable" });
      continue;
    }
    if (!escapeeRootedInWorktree({ cwd, command, argv }, roots)) {
      held.push({ pid: descendant.pid, startIdentity: descendant.startIdentity, reason: "outside the QA worktree" });
      continue;
    }
    try { signal(descendant.pid, "SIGTERM"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
      held.push({ pid: descendant.pid, startIdentity: descendant.startIdentity, reason: "SIGTERM was refused" });
      continue;
    }
    const deadline = Date.now() + graceMs;
    while (liveness(descendant.pid, descendant.startIdentity) === "alive" && Date.now() < deadline) {
      await sleep(Math.min(50, Math.max(0, deadline - Date.now())));
    }
    if (liveness(descendant.pid, descendant.startIdentity) !== "alive") {
      reaped.push({ pid: descendant.pid, startIdentity: descendant.startIdentity });
      continue;
    }
    try { signal(descendant.pid, "SIGKILL"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        reaped.push({ pid: descendant.pid, startIdentity: descendant.startIdentity });
        continue;
      }
      held.push({ pid: descendant.pid, startIdentity: descendant.startIdentity, reason: "SIGKILL was refused" });
      continue;
    }
    const killDeadline = Date.now() + Math.min(1_000, graceMs);
    while (liveness(descendant.pid, descendant.startIdentity) === "alive" && Date.now() < killDeadline) {
      await sleep(Math.min(50, Math.max(0, killDeadline - Date.now())));
    }
    if (liveness(descendant.pid, descendant.startIdentity) !== "alive")
      reaped.push({ pid: descendant.pid, startIdentity: descendant.startIdentity });
    else held.push({ pid: descendant.pid, startIdentity: descendant.startIdentity, reason: "still running after SIGKILL" });
  }
  return { reaped, held };
}

async function gitText(cwd: string, ...args: string[]): Promise<string> {
  const result = await gitRaw(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim() || `exit ${result.code}`}`);
  return result.stdout.toString("utf8").trim();
}
export { gitText as projectQaGitText };

/** Read the optional `worktree.setup` and `worktree.teardown` from a manifest's parsed bytes. */
export function parseProjectQaWorktreeHooks(source: string): ProjectQaWorktreeHooks {
  const manifest = JSON.parse(source) as { worktree?: unknown };
  if (manifest.worktree === undefined) return { setup: null, teardown: null };
  if (!manifest.worktree || typeof manifest.worktree !== "object" || Array.isArray(manifest.worktree))
    throw new Error("paseo.json worktree must be an object");
  const worktree = manifest.worktree as Record<string, unknown>;
  for (const key of ["setup", "teardown"] as const) {
    if (worktree[key] !== undefined && typeof worktree[key] !== "string")
      throw new Error(`paseo.json worktree.${key} must be a string`);
  }
  return { setup: (worktree.setup as string | undefined) ?? null, teardown: (worktree.teardown as string | undefined) ?? null };
}

/** Read a checkout's manifest worktree hooks; a missing manifest is no hooks. */
export async function projectQaWorktreeHooks(root: string): Promise<ProjectQaWorktreeHooks> {
  let source: string;
  try { source = readFileSync(join(root, "paseo.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { setup: null, teardown: null };
    throw error;
  }
  return parseProjectQaWorktreeHooks(source);
}

/**
 * Place one sibling link in the run root, matching the path the repository's
 * own `nucleus worktree prepare` derives from the primary checkout. Queue owns
 * this link namespace for the repository's QA root, so a link left by an
 * earlier run (or by a failed teardown of one) is replaced when its source
 * moved; the source checkout itself is never touched.
 */
export async function installQaSiblingLink(runRoot: string, name: string, target: string): Promise<void> {
  const linkPath = join(runRoot, name);
  const existing = await lstat(linkPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (!existing.isSymbolicLink())
      throw new Error(`Project QA sibling path is occupied by a non-symlink: ${linkPath}`);
    const current = await realpath(linkPath).catch(() => null);
    const wanted = await realpath(target).catch(() => resolve(target));
    if (current === wanted) return;
    await rm(linkPath, { force: true });
  }
  await symlink(target, linkPath);
}

/**
 * Remove one run's Queue-owned checkout. The checkout is a linked worktree of
 * the registered repository, so it is detached through Git first and this
 * run's administrative worktree entry is pruned; a lost run's directory is
 * already gone and only the registration remains. Registered checkout
 * contents are never touched.
 */
export async function removeQaWorkspace(paths: { registeredPath: string; checkoutPath: string; admission?: () => void; expectedHead?: string }): Promise<void> {
  paths.admission?.();
  if (paths.admission) {
    if (!paths.expectedHead || findGitWorktreeAdd(paths.checkoutPath).state !== "absent") throw Error("Project QA creation identity is uncertain");
    const trees = parseWorktreeList(await gitText(paths.registeredPath, "worktree", "list", "--porcelain"))
      .filter(tree => tree.path === paths.checkoutPath);
    if (existsSync(paths.checkoutPath)) {
      if (trees.length !== 1 || trees[0].head !== paths.expectedHead || trees[0].branch ||
          await repoCommonDir(paths.checkoutPath) !== await repoCommonDir(paths.registeredPath))
        throw Error("Project QA checkout identity changed; preserving it");
    } else if (trees.length) throw Error("Project QA checkout disappearance is uncertain");
    paths.admission();
  }
  // A run from the pre-Spec-022 layout left a private source tree here.
  const marker = await lstat(join(paths.checkoutPath, ".git")).catch(() => null);
  if (existsSync(paths.checkoutPath)) {
    const removed = marker?.isFile() ? await gitRaw(paths.registeredPath, ["worktree", "remove", "--force", paths.checkoutPath]) : null;
    if (!removed || removed.code !== 0) {
      if (paths.admission) throw new Error("Project QA checkout removal is uncertain; preserving it");
      await rm(paths.checkoutPath, { recursive: true, force: true });
    }
  }
  if (!paths.admission) await gitRaw(paths.registeredPath, ["worktree", "prune"]).catch(() => { /* Legacy cleanup. */ });
}

/** One run's immutable plan plus its pipeline inputs, as the detached supervisor receives them. */
export interface QaPipelineRun {
  runId: string;
  key: string;
  caller: string;
  base: string;
  baseBranch: string;
  startedAt: string;
  startedAtMs: number;
  checkoutPath: string;
  checkoutAdmission?: () => void;
  registeredPath: string;
  runRoot: string;
  argv: string[];
  /** The ordered stages this run executes, each one recorded step. */
  stages: ProjectQaStage[];
  timeoutMs: number;
  maxOutputBytes: number;
  terminationGraceMs: number;
  epoch: number;
  runClass?: "heavy" | "light";
  hostRunStateDir?: string;
  hostRunToken?: string;
  links: { name: string; target: string }[];
  temporaryDirectory?: string;
}

export interface QaSpawnedProcess {
  pid: number;
  processGroupId: number;
  leaderStartIdentity: string;
  startIdentity: string;
}

/** The observable identity of the process running the pipeline. */
export interface QaPipelineIdentity { pid: number; identityToken: string }

/** How one pipeline executes its steps and records progress; the service fakes the first two in tests. */
export interface QaPipelineIo {
  environment?(eventId: string, root: string): Promise<Record<string, string>> | Record<string, string>;
  hook(script: string, root: string, onSpawn?: (process: QaSpawnedProcess) => void, cancelable?: boolean, env?: Record<string, string>): Promise<ExecutionOutcome>;
  command(stage: ProjectQaStage, root: string, onSpawn?: (process: QaSpawnedProcess) => void, cancelable?: boolean, env?: Record<string, string>, onOutput?: (stream: "stdout" | "stderr", chunk: Buffer) => void): Promise<ExecutionOutcome>;
  cancellation?(): QaCancelRequest | null;
  writeHostResult?(result: HostRunResult): void;
  /** Write the private CPU-reason sidecar; best effort, ahead of the host result. */
  writeCpuCoverage?(sidecar: HostRunCpuCoverageSidecar): void;
  /** Record the state durably before the next observable change. */
  persist(state: QaSupervisionState): void;
  /** Begin background observation (the detached supervisor's heartbeat); returns its stop. */
  begin?(state: QaSupervisionState): () => void;
  /** Cumulative identity-scoped process-tree CPU with its coverage, or null when there is no sampler. */
  cpu?(): ProcessTreeCpu | null;
  /** Write one step's full-output log; production uses the mode-0600 file writer, tests inject one. */
  log?(path: string, buffer: Buffer): { bytes: number | null; error: string | null };
  now(): number;
}

/** What the pipeline settles; the service turns this into the durable run record. */
export interface QaPipelineOutcome {
  state: ProjectQaRun["state"];
  exitCode: number | null;
  durationMs: number;
  detail: string;
  steps: ProjectQaStep[];
  failedStep: ProjectQaStepName | null;
  /** #136: bounded full-output log-write failures; absent keeps the row's existing list. */
  logWriteErrors?: ProjectQaLogWriteError[];
  /** Task 191: the extracted TAP failures, or null when no QA stage reported one. */
  failuresLog?: string | null;
  /** Task 290: compact TAP identities and count coverage, separate from verbose blocks. */
  failureIndexes?: ProjectQaFailureIndex[];
  finishedAt: string;
  hostResult: HostRunResult | null;
  /** Queue-internal reason for `hostResult.cpuMs`, from the same sample; absent when unknown. */
  cpuCoverage?: HostRunCpuCoverage;
  escapedDescendants: HostRunResult["escapedDescendants"];
  cancelReason: string | null;
  checkoutCleanupPending?: boolean;
}

/** Append one log-write failure, newest-last and bounded so a broken writer cannot grow the record. */
function recordLogWriteError(errors: ProjectQaLogWriteError[], entry: { step: ProjectQaStepName; stream: "stdout" | "stderr"; error: string }): ProjectQaLogWriteError[] {
  return [...errors, { step: entry.step, stream: entry.stream, error: entry.error.slice(0, 4000) }].slice(-PROJECT_QA_LOG_WRITE_ERRORS_MAX);
}

/** One execution predicate for initial, recovered and retried QA steps. */
export function qaExecutionFailed(execution: Pick<ExecutionOutcome, "code" | "signal" | "timedOut" | "terminationError" | "processGroupEmpty">): boolean {
  return execution.code !== 0 || Boolean(execution.signal || execution.timedOut || execution.terminationError || execution.processGroupEmpty === false);
}

export function mergeQaEscapees(...groups: ReadonlyArray<readonly HostRunEscapedDescendant[]>): HostRunEscapedDescendant[] {
  return [...new Map(groups.flat().map(item => [`${item.pid}:${item.startIdentity}`, item])).values()];
}

/** The same process evidence, excerpts and log paths survive every execution path. */
export function qaStepRecord(name: ProjectQaStepName, command: string, execution: ExecutionOutcome,
  logs: ReturnType<typeof qaStepLogPaths>, stdoutLog: ReturnType<typeof writeQaStepLog>, stderrLog: ReturnType<typeof writeQaStepLog>,
  shapeNote?: string): ProjectQaStep {
  const stdout = streamHeadTail(execution.stdout, PROJECT_QA_STEP_OUTPUT_BYTES, streamTruncation(execution.stdoutObservedBytes, execution.stdoutOmittedBytes), shapeNote);
  const stderr = streamHeadTail(execution.stderr, PROJECT_QA_STEP_OUTPUT_BYTES, streamTruncation(execution.stderrObservedBytes, execution.stderrOmittedBytes), shapeNote);
  return { name, command, exitCode: execution.code, signal: execution.signal, timedOut: execution.timedOut,
    pid: execution.pid, startIdentity: execution.startIdentity ?? null, escapedDescendants: execution.escapedDescendants ?? [],
    startedAt: execution.startedAt, endedAt: execution.endedAt, wallMs: execution.durationMs,
    processGroupId: execution.processGroupId ?? null, leaderStartIdentity: execution.leaderStartIdentity ?? null,
    terminationSignal: execution.terminationSignal ?? null, processGroupEmpty: execution.processGroupEmpty ?? null,
    terminationError: execution.terminationError ?? null,
    stdoutHead: stdout.head, stdoutTail: stdout.tail, stderrHead: stderr.head, stderrTail: stderr.tail,
    stdoutLogPath: stdoutLog.bytes === null ? null : logs.stdoutPath, stderrLogPath: stderrLog.bytes === null ? null : logs.stderrPath,
    stdoutBytes: stdoutLog.bytes ?? 0, stderrBytes: stderrLog.bytes ?? 0 };
}

async function reapPipelineEscapees(state: QaSupervisionState, run: QaPipelineRun): Promise<void> {
  if (!state.escapedDescendants.length) return;
  const reap = await reapQaWorktreeEscapees(state.escapedDescendants,
    { checkoutPath: run.checkoutPath, runRoot: run.runRoot }, { graceMs: run.terminationGraceMs });
  if (!reap.reaped.length && !reap.held.length) return;
  const parts: string[] = [];
  if (reap.reaped.length) parts.push(`reaped ${reap.reaped.length} escaped descendant(s) rooted in the QA worktree (${reap.reaped.map(descendant => `pid ${descendant.pid}`).join(", ")})`);
  if (reap.held.length) parts.push(`${reap.held.length} escapee(s) keep their capacity hold (${reap.held.map(descendant => `pid ${descendant.pid}: ${descendant.reason}`).join(", ")})`);
  state.detail = `${state.detail}${state.detail ? "\n" : ""}Escapee reap: ${parts.join("; ")}.`;
}

/** Create the run's checkout as a linked worktree and place its sibling links. */
async function preparePipelineCheckout(run: QaPipelineRun): Promise<void> {
  await mkdir(run.runRoot, { recursive: true, mode: 0o700 });
  run.checkoutAdmission?.();
  // The run ID is fresh, so this only clears a directory left by an earlier
  // attempt at this exact ID; the registration below is still authoritative.
  if (run.checkoutAdmission) {
    if (existsSync(run.checkoutPath)) throw new Error("Project QA checkout already exists; creation is uncertain");
    await mkdir(dirname(run.checkoutPath), { recursive: true, mode: 0o700 });
    run.checkoutAdmission();
  } else await rm(run.checkoutPath, { recursive: true, force: true });
  await gitText(run.registeredPath, "worktree", "add", "--detach", "--", run.checkoutPath, run.base);
  for (const link of run.links) await installQaSiblingLink(dirname(run.checkoutPath), link.name, link.target);
  const head = await gitText(run.checkoutPath, "rev-parse", "HEAD");
  if (head !== run.base) throw new Error("QA checkout HEAD differs from the fetched integration head");
}

/**
 * Run setup, QA and teardown in order, recording the run's progress after every
 * observable change. A failed setup or a checkout failure skips QA; teardown
 * runs whenever the disposable checkout exists, including after setup, QA and
 * checkout failures; the Queue-owned checkout is removed unless teardown failed.
 */
export async function runProjectQaPipeline(base: QaPipelineIdentity, run: QaPipelineRun, io: QaPipelineIo): Promise<QaPipelineOutcome> {
  const state: QaSupervisionState = {
    schema: QA_SUPERVISION_SCHEMA, schema_version: QA_SUPERVISION_SCHEMA_VERSION,
    runId: run.runId, key: run.key, pid: base.pid, supervisorStartIdentity: hostRunProcessStartIdentity(base.pid), identityToken: base.identityToken,
    startedAt: run.startedAt, heartbeatAt: new Date(io.now()).toISOString(),
    inFlight: null, activeProcess: null, pendingProcessIdentity: null, steps: [], failedStep: null, logWriteErrors: [], detail: "",
    failuresLog: "", failureIndexes: [], escapedDescendants: [], cancelReason: null, result: null,
  };
  let stop: (() => void) | undefined;
  // The operator's live view of this run: every stage's output as it arrives.
  // Best effort by construction; the step logs and the result stay the record.
  const liveOutput = openLiveOutputLog(qaRunLiveOutputPath(run.runRoot, run.runId), () => run.hostRunToken);
  try {
    // Publish the run's identity before anything can take time, so a service
    // restart in this window finds a live supervisor rather than an orphan.
    io.persist(state);
    stop = io.begin?.(state);
    let stateName: ProjectQaRun["state"] = "hold";
    let exitCode: number | null = null;
    let setupFailed = false;
    let teardownFailed = false;
    let checkoutPrepared = false;
    let checkoutCleanupPending = false;
    let hooks: ProjectQaWorktreeHooks = { setup: null, teardown: null };
    const updateCancellation = () => {
      const request = io.cancellation?.() ?? null;
      if (!request) return false;
      if (state.cancelReason !== request.reason)
        state.detail = `${state.detail}${state.detail ? "\n" : ""}QA cancelled: ${request.reason}`;
      state.cancelReason = request.reason;
      stateName = "cancelled";
      io.persist(state);
      return true;
    };
    const onSpawn = (step: ProjectQaStepName) => (spawned: QaSpawnedProcess) => {
      state.activeProcess = { step, pid: spawned.pid, processGroupId: spawned.processGroupId,
        startIdentity: spawned.startIdentity, leaderStartIdentity: spawned.leaderStartIdentity,
        startedAt: new Date(io.now()).toISOString() };
      state.pendingProcessIdentity = null;
      io.persist(state);
    };
    const recordStep = (name: ProjectQaStepName, command: string, execution: ExecutionOutcome, tapCollector?: StreamingTapFailures | null) => {
      // Task 388: the executor keeps a bounded beginning and end and reports what
      // its cap dropped, so the step's own excerpts carry the same statement.
      // Task 590: QA stage steps trim passing output before failure lines, so
      // their excerpt markers name that shape instead of beginning-and-end.
      const shapeNote = tapCollector ? FAILURE_FIRST_RETENTION_NOTE : undefined;
      state.activeProcess = null;
      state.pendingProcessIdentity = null;
      // #121: keep each step's full output (already tail-capped at the step's
      // maxOutputBytes by the executor) in a log beside the run, so a short
      // excerpt can never be the only record of a long compile or clippy run.
      // A log that cannot be written is reported on the run, never silently
      // indistinguishable from a step that produced no output.
      const writeLog = io.log ?? writeQaStepLog;
      const logs = qaStepLogPaths(run.runRoot, run.runId, name);
      const stdoutLog = writeLog(logs.stdoutPath, execution.stdout);
      const stderrLog = writeLog(logs.stderrPath, execution.stderr);
      for (const [stream, log] of [["stdout", stdoutLog], ["stderr", stderrLog]] as const)
        if (log.error) {
          state.detail = `${state.detail}${state.detail ? "\n" : ""}Full-output log for step ${name} (${stream}) could not be written: ${log.error}`;
          state.logWriteErrors = recordLogWriteError(state.logWriteErrors, { step: name, stream, error: log.error });
        }
      const escaped = execution.escapedDescendants ?? [];
      state.escapedDescendants = mergeQaEscapees(state.escapedDescendants, escaped);
      state.steps.push(qaStepRecord(name, command, execution, logs, stdoutLog, stderrLog, shapeNote));
      if (!execution.cancelled && qaExecutionFailed(execution)) state.failedStep ??= name;
      // Task 191: TAP failures stream in per chunk before any byte cap, so
      // the failures log survives whatever the caps keep or evict. Executors
      // that predate the streaming sink fall back to the retained buffers.
      if (run.stages.some(stage => stage.name === name)) {
        const collector = tapCollector ?? null;
        const extracted = collector?.result() ?? null;
        const redacted = run.hostRunToken && extracted ? extracted.replaceAll(run.hostRunToken, "[REDACTED]") : extracted;
        state.failuresLog = appendFailuresLog(state.failuresLog, redacted, name);
        const index = redactFailureIndex(collector?.index() ?? null, run.hostRunToken);
        if (index) state.failureIndexes = [...(state.failureIndexes ?? []), { stage: name, ...index }];
        else if (!execution.cancelled && qaExecutionFailed(execution)) {
          const pointers = [stdoutLog.bytes === null ? null : logs.stdoutPath, stderrLog.bytes === null ? null : logs.stderrPath].filter(Boolean);
          const pointerText = pointers.length ? `Retained output: ${pointers.join(", ")}` : "No retained full-output log was available; inspect the step excerpts.";
          state.failuresLog = appendFailuresLog(state.failuresLog, `No TAP failure details were reported. ${pointerText}`, name);
          state.failureIndexes = [...(state.failureIndexes ?? []), { stage: name, tests: null, failed: 1,
            cancelled: 0, skipped: null, identities: [{ id: null, title: `Command failed; inspect retained output for ${name}`, ...boundedFailureLocation(pointers[0] ?? null), status: "failed" as const }],
            omittedIdentities: 0, truncated: false, diagnosticsTruncated: false }];
        }
      }
    };
    try {
      if (updateCancellation()) {
        // A cancellation before any step is launched has no checkout to tear down.
      } else {
      await preparePipelineCheckout(run);
      checkoutPrepared = true;
      run.checkoutAdmission?.();
      hooks = await projectQaWorktreeHooks(run.checkoutPath);
      if (hooks.setup) {
        if (updateCancellation()) setupFailed = true;
        else {
        run.checkoutAdmission?.();
        const env = await io.environment?.(`project-qa:${run.runId}`, run.checkoutPath);
        state.inFlight = "setup"; state.pendingProcessIdentity = base.identityToken; io.persist(state);
        const setup = await io.hook(hooks.setup, run.checkoutPath, onSpawn("setup"), true, env);
        recordStep("setup", hooks.setup, setup);
        state.inFlight = null;
        const output = executionOutput(setup);
        if (setup.cancelled || updateCancellation()) {
          setupFailed = true;
          stateName = "cancelled";
        } else if (qaExecutionFailed(setup)) {
          setupFailed = true;
          stateName = setup.timedOut ? "timed_out" : "hold";
          // Append rather than replace: recordStep's log-write diagnostic (when
          // a full-output log could not be written) must survive setup output.
          const failure = `QA worktree setup failed${setup.timedOut ? " (timed out)" : setup.signal ? ` (${setup.signal})` : ` (exit ${setup.code})`}${output ? `:\n${output}` : "."}`;
          state.detail = `${state.detail}${state.detail ? "\n" : ""}${failure}`;
        } else if (output) state.detail = `${state.detail}${state.detail ? "\n" : ""}Worktree setup output:\n${output}`;
        io.persist(state);
        }
      }
      if (!setupFailed) {
        // #121: stages run in order in the one owned checkout. The first
        // failing stage stops the run (and names failedStep); teardown still runs.
        stateName = "passed";
        for (const stage of run.stages) {
          if (updateCancellation()) { stateName = "cancelled"; break; }
          run.checkoutAdmission?.();
          const env = await io.environment?.(`project-qa:${run.runId}`, run.checkoutPath);
          state.inFlight = stage.name; state.pendingProcessIdentity = base.identityToken; io.persist(state);
          const tapCollector = new StreamingTapFailures(run.hostRunToken, Math.floor(PROJECT_QA_FAILURES_BYTES / Math.max(1, run.stages.length)));
          const execution = await io.command(stage, run.checkoutPath, onSpawn(stage.name), true, env,
            (_stream, chunk) => { tapCollector.push(chunk); liveOutput?.write(chunk); });
          exitCode = execution.code;
          recordStep(stage.name, stage.argv.join(" "), execution, tapCollector);
          state.inFlight = null;
          const output = executionOutput(execution);
          if (output) state.detail = `${state.detail}${state.detail ? "\n" : ""}${output}`;
          if (execution.cancelled || updateCancellation()) { stateName = "cancelled"; }
          else if (execution.timedOut) { stateName = "timed_out"; state.detail = `${stage.name} timed out: ${state.detail}`; }
          else if (execution.signal) { stateName = "hold"; state.detail = `${stage.name} terminated by ${execution.signal}: ${state.detail}`; }
          else if (execution.terminationError || execution.processGroupEmpty === false) stateName = "hold";
          else if (execution.code !== 0) stateName = "failed";
          else stateName = "passed";
          io.persist(state);
          if (stateName !== "passed") break;
        }
        io.persist(state);
      }
      }
    } catch (error) {
      stateName = updateCancellation() ? "cancelled" : "hold";
      if (stateName !== "cancelled") state.detail = `${setupFailed ? "QA worktree setup" : "QA checkout or launch"} failed: ${String(error)}${state.detail ? `\n${state.detail}` : ""}`;
      setupFailed = true;
    }
    try {
      // A failed setup can leave partial state, so teardown runs whenever the
      // disposable worktree exists, including after setup and QA failures.
      if (hooks.teardown) run.checkoutAdmission?.();
      if (hooks.teardown && existsSync(run.checkoutPath)) {
        const env = await io.environment?.(`project-qa:${run.runId}`, run.checkoutPath);
        state.inFlight = "teardown"; state.pendingProcessIdentity = base.identityToken; io.persist(state);
        const teardown = await io.hook(hooks.teardown, run.checkoutPath, onSpawn("teardown"), false, env);
        recordStep("teardown", hooks.teardown, teardown);
        state.inFlight = null;
        const output = executionOutput(teardown);
        if (output) state.detail = `${state.detail}${state.detail ? "\n" : ""}Worktree teardown output:\n${output}`;
        if (!teardown.cancelled && qaExecutionFailed(teardown)) {
          teardownFailed = true;
          if (!state.cancelReason) stateName = teardown.timedOut ? "timed_out" : "hold";
          state.detail = `${state.detail}${state.detail ? "\n" : ""}QA worktree teardown failed${teardown.timedOut ? " (timed out)" : teardown.signal ? ` (${teardown.signal})` : ` (exit ${teardown.code})`}.`;
          state.detail += "\nNext action: retry teardown to clean up the retained checkout.";
        }
        io.persist(state);
      }
    } catch (error) {
      teardownFailed = true;
      state.failedStep ??= "teardown";
      if (!updateCancellation()) stateName = "hold";
      state.detail = `${state.detail}${state.detail ? "\n" : ""}QA worktree teardown failed: ${String(error)}`;
      state.detail += "\nNext action: retry teardown to clean up the retained checkout.";
      io.persist(state);
    }
    // Task 191: after the QA step and teardown, reap this run's own escaped
    // descendants that are rooted in its Queue-owned QA worktree, so the
    // scheduler can prove them dead and release capacity. Escapees outside
    // the worktree keep today's hold.
    await reapPipelineEscapees(state, run);
    io.persist(state);
    // Each step's own output is recorded above, but the run's shared tail can
    // only keep so much: a failing step's own error is re-stated last so later
    // teardown output can never evict it (Spec 022).
    const failed = state.failedStep ? state.steps.find(step => step.name === state.failedStep) : undefined;
    if (failed) {
      const own = [failed.stderrTail || failed.stderrHead, failed.stdoutTail || failed.stdoutHead]
        .map(text => text.trim()).filter(Boolean).join("\n");
      if (own) state.detail = `${state.detail}${state.detail ? "\n" : ""}Failing step (${failed.name}) output:\n${own}`;
    }
    if (state.failureIndexes?.length) {
      const coverage = failureCoverageDetail(state.failureIndexes);
      state.detail = `${state.detail}${state.detail ? "\n" : ""}TAP failure inventory:\n${coverage}`;
    }
    const durationMs = io.now() - run.startedAtMs;
    try {
      if (!teardownFailed && (!run.checkoutAdmission || checkoutPrepared)) await removeQaWorkspace({ registeredPath: run.registeredPath, checkoutPath: run.checkoutPath, admission: run.checkoutAdmission, expectedHead: run.base });
      else if (run.checkoutAdmission && !checkoutPrepared) state.detail += "\nQA checkout creation is uncertain; retained for reconciliation.";
    } catch (error) {
      stateName = "hold";
      if (run.checkoutAdmission) checkoutCleanupPending = true;
      state.detail = `${state.detail}${state.detail ? "\n" : ""}QA checkout cleanup requires reconciliation: ${String(error)}`;
    }
    updateCancellation();
    const finishedAt = new Date(io.now()).toISOString();
    // #121: the host result must name the command that decided the run. A
    // failed step wins; otherwise a staged run names its last executed stage.
    // A stage is free to be called `qa` (only setup/teardown are reserved), so
    // the name `qa` never outranks a later stage. A legacy single-command run
    // is one `qa` stage, so it selects that step as before.
    const stageNames = new Set(run.stages.map(stage => stage.name));
    const executedStages = state.steps.filter(step => stageNames.has(step.name));
    const primary = (state.failedStep ? state.steps.find(step => step.name === state.failedStep) : undefined)
      ?? executedStages.at(-1)
      ?? state.steps.find(step => step.name === "setup")
      ?? state.steps[0];
    // One sample feeds the Contract 010 cpuMs and the Queue-internal reason beside it.
    const cpu = io.cpu?.() ?? null;
    const hostResult = primary?.processGroupId ? hostRunResultSchema.parse({
      format: "host.run.result", version: 1, runId: run.runId, epoch: run.epoch,
      pgid: primary.processGroupId,
      startIdentity: primary.startIdentity ?? hostRunProcessStartIdentity(primary.pid ?? primary.processGroupId),
      exitCode: primary.signal ? null : primary.exitCode ?? (stateName === "passed" ? 0 : 1),
      signal: primary.signal,
      startedAt: primary.startedAt ?? run.startedAt, endedAt: primary.endedAt ?? finishedAt,
      wallMs: primary.wallMs ?? Math.max(0, durationMs), cpuMs: cpu?.cpuMs ?? null,
      escapedDescendants: state.escapedDescendants,
    }) : !primary && io.writeHostResult && stateName !== "cancelled" ? hostRunResultSchema.parse({
      format: "host.run.result", version: 1, runId: run.runId, epoch: run.epoch,
      pgid: base.pid, startIdentity: hostRunProcessStartIdentity(base.pid),
      exitCode: stateName === "passed" ? 0 : 1, signal: null,
      startedAt: run.startedAt, endedAt: finishedAt, wallMs: Math.max(0, durationMs), cpuMs: cpu?.cpuMs ?? null,
      escapedDescendants: state.escapedDescendants,
    }) : null;
    const cpuCoverage = hostResult && cpu ? cpu.cpuCoverage : undefined;
    if (hostResult && cpuCoverage) {
      try { io.writeCpuCoverage?.(hostRunCpuCoverageSidecar({ runId: run.runId, epoch: run.epoch, ...(primary?.processGroupId ? { step: primary.name } : {}) }, hostResult.cpuMs, cpuCoverage)); }
      catch { /* the reason stays unknown */ }
    }
    if (hostResult) io.writeHostResult?.(hostResult);
    state.result = { state: stateName, exitCode, durationMs, detail: state.detail,
      failureIndexes: state.failureIndexes ?? [], finishedAt, hostResult, ...(checkoutCleanupPending ? { checkoutCleanupPending } : {}) };
    io.persist(state);
    return { state: stateName, exitCode, durationMs, detail: state.detail, steps: state.steps, failedStep: state.failedStep,
      logWriteErrors: state.logWriteErrors, failuresLog: state.failuresLog || null, failureIndexes: state.failureIndexes ?? [], finishedAt,
      hostResult, ...(cpuCoverage ? { cpuCoverage } : {}), escapedDescendants: state.escapedDescendants, cancelReason: state.cancelReason,
      ...(checkoutCleanupPending ? { checkoutCleanupPending } : {}) };
  } finally {
    stop?.();
    liveOutput?.close();
  }
}

/**
 * Task 134: rerun only the recorded teardown command for a settled run whose
 * `failedStep` is `teardown`, through the same hook executor, process-group
 * termination and step logging as the original pipeline. The prior steps are
 * carried verbatim, so the QA step's result, exit code and output never change;
 * this only appends a new teardown attempt. A successful retry removes the
 * Queue-owned checkout and settles to the state the QA result implies; a failed
 * retry stays `hold` with the checkout retained.
 */
export async function runQaTeardownRetry(
  base: QaPipelineIdentity, run: QaPipelineRun, io: QaPipelineIo,
  retry: { command: string; priorSteps: ProjectQaStep[]; qaExitCode: number | null; priorCancelReason: string | null; reason: string; cleanupOnly?: boolean; priorFailedStep?: ProjectQaStepName | null },
): Promise<QaPipelineOutcome> {
  const state: QaSupervisionState = {
    schema: QA_SUPERVISION_SCHEMA, schema_version: QA_SUPERVISION_SCHEMA_VERSION,
    runId: run.runId, key: run.key, pid: base.pid, identityToken: base.identityToken,
    startedAt: run.startedAt, heartbeatAt: new Date(io.now()).toISOString(),
    inFlight: null, activeProcess: null, pendingProcessIdentity: null,
    steps: [...retry.priorSteps], failedStep: null, logWriteErrors: [], detail: `Teardown retry: ${retry.reason}`,
    escapedDescendants: [], cancelReason: retry.priorCancelReason, result: null,
  };
  let stop: (() => void) | undefined;
  try {
    io.persist(state);
    stop = io.begin?.(state);
    let teardownFailed = false;
    let teardownCompleted = Boolean(retry.cleanupOnly);
    try {
      run.checkoutAdmission?.();
      if (existsSync(run.checkoutPath) && !retry.cleanupOnly) {
        const env = await io.environment?.(`project-qa:${run.runId}`, run.checkoutPath);
        state.inFlight = "teardown"; state.pendingProcessIdentity = base.identityToken; io.persist(state);
        const teardown = await io.hook(retry.command, run.checkoutPath, spawned => {
          state.activeProcess = { step: "teardown", pid: spawned.pid, processGroupId: spawned.processGroupId,
            startIdentity: spawned.startIdentity, leaderStartIdentity: spawned.leaderStartIdentity,
            startedAt: new Date(io.now()).toISOString() };
          state.pendingProcessIdentity = null;
          io.persist(state);
        }, false, env);
        state.inFlight = null;
        state.activeProcess = null;
        state.pendingProcessIdentity = null;
        state.escapedDescendants = mergeQaEscapees(state.escapedDescendants, teardown.escapedDescendants ?? []);
        // #121 keeps every step's full output in a log; a retried teardown gets its own
        // attempt-numbered log so the original failed attempt's log is never overwritten.
        const attempt = state.steps.filter(step => step.name === "teardown").length + 1;
        const logs = qaStepLogPaths(run.runRoot, run.runId, `teardown-attempt-${attempt}`);
        const writeLog = io.log ?? writeQaStepLog;
        const stdoutLog = writeLog(logs.stdoutPath, teardown.stdout);
        const stderrLog = writeLog(logs.stderrPath, teardown.stderr);
        for (const [stream, log] of [["stdout", stdoutLog], ["stderr", stderrLog]] as const)
          if (log.error) {
            state.detail = `${state.detail}${state.detail ? "\n" : ""}Full-output log for teardown retry (${stream}) could not be written: ${log.error}`;
            state.logWriteErrors = recordLogWriteError(state.logWriteErrors, { step: "teardown", stream, error: log.error });
          }
        state.steps.push(qaStepRecord("teardown", retry.command, teardown, logs, stdoutLog, stderrLog));
        const output = executionOutput(teardown);
        if (output) state.detail = `${state.detail}${state.detail ? "\n" : ""}Worktree teardown output:\n${output}`;
        if (qaExecutionFailed(teardown)) {
          teardownFailed = true;
          state.detail = `${state.detail}${state.detail ? "\n" : ""}QA worktree teardown failed${teardown.timedOut ? " (timed out)" : teardown.signal ? ` (${teardown.signal})` : ` (exit ${teardown.code})`}.`;
        } else teardownCompleted = true;
      } else if (!existsSync(run.checkoutPath)) {
        state.detail = `${state.detail}${state.detail ? "\n" : ""}The retained checkout is gone; there is nothing to tear down.`;
      }
    } catch (error) {
      teardownFailed = true;
      state.detail = `${state.detail}${state.detail ? "\n" : ""}QA worktree teardown failed: ${String(error)}`;
    }
    // Task 191: a retried teardown can strand its own escapees too.
    await reapPipelineEscapees(state, run);
    io.persist(state);
    if (!teardownFailed) {
      try {
        await removeQaWorkspace({ registeredPath: run.registeredPath, checkoutPath: run.checkoutPath, admission: run.checkoutAdmission, expectedHead: run.base });
        state.failedStep = retry.priorFailedStep === "teardown" ? null : retry.priorFailedStep ?? null;
        state.detail = `${state.detail}${state.detail ? "\n" : ""}The Queue-owned checkout was removed.`;
      } catch (error) {
        teardownFailed = true;
        state.failedStep = retry.cleanupOnly ? retry.priorFailedStep ?? null : "teardown";
        state.detail = `${state.detail}${state.detail ? "\n" : ""}QA checkout cleanup requires reconciliation: ${String(error)}`;
      }
    } else {
      state.failedStep = "teardown";
    }
    const stateName: ProjectQaRun["state"] = teardownFailed ? "hold" : retry.qaExitCode === 0 ? "passed" : "failed";
    const finishedAt = new Date(io.now()).toISOString();
    const durationMs = Math.max(0, io.now() - run.startedAtMs);
    const checkoutCleanupPending = Boolean(run.checkoutAdmission && teardownCompleted && teardownFailed);
    state.result = { state: stateName, exitCode: retry.qaExitCode, durationMs, detail: state.detail, finishedAt, hostResult: null,
      checkoutCleanupPending };
    io.persist(state);
    return { state: stateName, exitCode: retry.qaExitCode, durationMs, detail: state.detail, steps: state.steps, failedStep: state.failedStep,
      logWriteErrors: state.logWriteErrors, finishedAt, hostResult: null, escapedDescendants: state.escapedDescendants, cancelReason: state.cancelReason,
      checkoutCleanupPending };
  } finally {
    stop?.();
  }
}

/** The real executors and durable file recording used by the detached supervisor. */
/**
 * Task 590: the pipeline's view of the run's host-run token. The supervisor
 * issues the token lazily in `environment`, after the pipeline's run object
 * is built, so the supervisor reports it back here: the streaming failure
 * collector, the step redaction and the live-output log all read the token
 * from the pipeline run, and without this sync they would keep an undefined
 * token in production and record the secret unredacted.
 */
export function detachedSupervisorIo(plan: QaSupervisionPlan, statePath: string, tokenHolder?: { hostRunToken?: string }): QaPipelineIo {
  const supervisorEnv = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const { resultPath, cancelPath, planPath, cpuCoveragePath } = qaSupervisionPaths(plan.runRoot, plan.runId, plan.attempt);
  let current: QaSupervisionState | null = null;
  let timer: NodeJS.Timeout | null = null;
  let cpuSampler: ProcessTreeCpuSampler | null = null;
  let finalCpu: ProcessTreeCpu | null = null;
  const persist = (state: QaSupervisionState) => writeQaSupervision(statePath, state);
  const redactExecution = async (execution: Promise<ExecutionOutcome>): Promise<ExecutionOutcome> => {
    const outcome = await execution;
    if (!plan.hostRunToken) return outcome;
    return { ...outcome, stdout: redactTokenBuffer(outcome.stdout, plan.hostRunToken), stderr: redactTokenBuffer(outcome.stderr, plan.hostRunToken) };
  };
  const executeOptions = (cancelable: boolean, onSpawn?: (process: QaSpawnedProcess) => void) => ({
    processStartIdentity: plan.identityToken,
    settleOnProcessGroup: true,
    cancelReason: cancelable ? () => readQaCancelRequest(cancelPath, plan.runId)?.reason ?? null : undefined,
    onSpawn: (pid: number, processGroupId?: number, leaderStartIdentity?: string, startIdentity?: string) => {
      // Steps run one at a time, each in its own group: CPU samples follow the current one.
      if (processGroupId && startIdentity) cpuSampler?.attachGroup({ pgid: processGroupId, leaderStartIdentity: startIdentity });
      if (pid && processGroupId && leaderStartIdentity && startIdentity)
        onSpawn?.({ pid, processGroupId, leaderStartIdentity, startIdentity });
    },
  });
  return {
    environment: (eventId, root) => {
      if (!plan.hostRunToken) {
        const launchedAt = Date.parse(plan.startedAt);
        plan.hostRunToken = issueHostRunToken(plan.hostRunStateDir ?? defaultHostRunStateDir(), {
          runId: plan.runId, epoch: plan.epoch, class: plan.runClass, root: realpathSync(root),
          exp: launchedAt + plan.timeoutMs + HOST_RUN_TOKEN_GRACE_MS,
        });
        writeQaSupervisionPlan(planPath, plan);
      }
      if (tokenHolder && plan.hostRunToken) tokenHolder.hostRunToken = plan.hostRunToken;
      return hostRunLaunchEnvironment(withRunTemporaryDirectory(minimalHookEnvironment(eventId), plan.temporaryDirectory), {
        runId: plan.runId, token: plan.hostRunToken, env: supervisorEnv,
      });
    },
    hook: (script, root, onSpawn, cancelable = true, stepEnv) => redactExecution(executeHookProgram({
      root, executable: "/bin/sh", argv: ["-lc", script], stdin: Buffer.alloc(0),
      timeoutMs: plan.hookTimeoutMs, maxOutputBytes: plan.hookMaxOutputBytes, overflow: "tail",
      terminationGraceMs: plan.terminationGraceMs,
      env: stepEnv ?? withRunTemporaryDirectory(supervisorEnv, plan.temporaryDirectory),
      ...executeOptions(cancelable, onSpawn),
    })),
    command: (stage, root, onSpawn, cancelable = true, stepEnv, onOutput) => redactExecution(executeHookProgram({
      root, executable: stage.argv[0], argv: stage.argv.slice(1), stdin: Buffer.alloc(0),
      timeoutMs: stage.timeoutMs, maxOutputBytes: stage.maxOutputBytes ?? plan.maxOutputBytes, overflow: "tail",
      // Task 590: passing test lines go before failure lines when the stage
      // output exceeds its cap, so the retained log keeps what failed.
      trimPassingFirst: true,
      terminationGraceMs: plan.terminationGraceMs,
      env: stepEnv ?? withRunTemporaryDirectory(minimalHookEnvironment(`project-qa:${plan.runId}`), plan.temporaryDirectory),
      ...executeOptions(cancelable, onSpawn),
      ...(onOutput ? { onOutput } : {}),
    })),
    cancellation: () => readQaCancelRequest(cancelPath, plan.runId),
    writeHostResult: result => { writeHostRunResult(resultPath, result); },
    writeCpuCoverage: sidecar => { writeOwnedJson(cpuCoveragePath, sidecar); },
    persist,
    cpu: () => cpuSampler?.read() ?? finalCpu,
    begin: state => {
      current = state;
      cpuSampler = new ProcessTreeCpuSampler(plan.identityToken);
      cpuSampler.start();
      timer = setInterval(() => {
        if (!current) return;
        current.heartbeatAt = new Date().toISOString();
        try { persist(current); } catch { /* a heartbeat that cannot write is retried next tick */ }
      }, SUPERVISOR_HEARTBEAT_MS);
      timer.unref?.();
      return () => {
        if (timer) clearInterval(timer);
        timer = null;
        finalCpu = cpuSampler?.stop() ?? null;
      };
    },
    now: Date.now,
  };
}
