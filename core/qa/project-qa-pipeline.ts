import { existsSync } from "node:fs";
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
import type { ExecutionOutcome } from "../machine/process-exec";
import { boundSidecarCoverage, hostRunCpuCoverageSidecar, type HostRunCpuCoverageSidecar } from "../host-runs/host-run-cpu-coverage";
import { type ProcessTreeCpu } from "../machine/process-group";
import { hostRunProcessStartIdentity } from "../machine/start-identity";
import { openLiveOutputLog } from "../machine/live-output";
import { FAILURE_FIRST_RETENTION_NOTE, boundedHeadTail, streamTruncation, type StreamTruncation } from "../machine/output-retention";
import {
  QA_SUPERVISION_SCHEMA,
  QA_SUPERVISION_SCHEMA_VERSION,
  qaStepLogPaths,
  qaRunLiveOutputPath,
  writeQaStepLog,
  type ProjectQaWorktreeHooks,
  type QaCancelRequest,
  type QaSupervisionState,
} from "./project-qa-supervision-files";
import { PROJECT_QA_FAILURES_BYTES, StreamingTapFailures, boundedFailureLocation, redactFailureIndex, failureCoverageDetail, appendFailuresLog } from "./project-qa-tap-failures";
import { reapQaWorktreeEscapees } from "./project-qa-escapees";
import { preparePipelineCheckout, projectQaWorktreeHooks, removeQaWorkspace } from "./project-qa-worktree";

/**
 * The milestone QA pipeline: checkout, setup, the ordered QA stages, teardown and
 * cleanup, recording every observable change as it settles.
 *
 * One owner for the run's execution order and its recorded shape. The pipeline
 * never writes the Queue store; the service settles the durable run from what
 * this records. The first failing stage stops the run, teardown still runs, and
 * every step keeps its own bounded excerpts and full-output log.
 */
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

/** Bytes of each stream kept as one step's own head and tail on the run record. */
export const PROJECT_QA_STEP_OUTPUT_BYTES = 512;

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
export function recordLogWriteError(errors: ProjectQaLogWriteError[], entry: { step: ProjectQaStepName; stream: "stdout" | "stderr"; error: string }): ProjectQaLogWriteError[] {
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

export async function reapPipelineEscapees(state: QaSupervisionState, run: QaPipelineRun): Promise<void> {
  if (!state.escapedDescendants.length) return;
  const reap = await reapQaWorktreeEscapees(state.escapedDescendants,
    { checkoutPath: run.checkoutPath, runRoot: run.runRoot }, { graceMs: run.terminationGraceMs });
  if (!reap.reaped.length && !reap.held.length) return;
  const parts: string[] = [];
  if (reap.reaped.length) parts.push(`reaped ${reap.reaped.length} escaped descendant(s) rooted in the QA worktree (${reap.reaped.map(descendant => `pid ${descendant.pid}`).join(", ")})`);
  if (reap.held.length) parts.push(`${reap.held.length} escapee(s) keep their capacity hold (${reap.held.map(descendant => `pid ${descendant.pid}: ${descendant.reason}`).join(", ")})`);
  state.detail = `${state.detail}${state.detail ? "\n" : ""}Escapee reap: ${parts.join("; ")}.`;
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
