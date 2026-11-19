import type { Store } from "../store/store";
import type { HostRunScheduler } from "../host-runs/host-run-scheduler";
import type { ProjectQaRun } from "../../shared/contracts";
import { chmodSync, closeSync, constants, fstatSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { readdir, lstat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { writeOwnedJson } from "../machine/owned-file.mjs";
import { readOwnedJson, type OwnedJsonRead } from "../machine/owned-read";
import { tailWithTruncationMarker } from "../machine/output-retention";
import { HOST_RUN_CPU_COVERAGE_FILE, parseCpuCoverageSidecar } from "../host-runs/host-run-cpu-coverage";
import {
  DEFAULT_PROCESS_TERMINATION_GRACE_MS,
  PROCESS_TERMINATION_GRACE_MAX_MS,
  projectQaLogWriteErrorSchema,
  projectQaFailureIndexSchema,
  projectQaStateSchema,
  projectQaStageSchema,
  projectQaStepNameSchema,
  projectQaStepSchema,
  hostRunResultSchema,
  PROJECT_QA_LOG_WRITE_ERRORS_MAX,
  type HostRunResult,
} from "../../shared/contracts";

/** Bound on the aggregate detail kept in the supervision file; the record keeps only its tail. */
export const PROJECT_QA_DETAIL_BYTES = 65_536;

export const QA_SUPERVISION_SCHEMA = "queue.project-qa.supervisor.v1";
export const QA_SUPERVISION_PLAN_SCHEMA = "queue.project-qa.plan.v1";
export const QA_SUPERVISION_SCHEMA_VERSION = 1;

export const projectQaWorktreeHooksSchema = z.object({
  setup: z.string().nullable(),
  teardown: z.string().nullable(),
}).strict();
export type ProjectQaWorktreeHooks = z.infer<typeof projectQaWorktreeHooksSchema>;

/**
 * One milestone run's durable plan, written by the service before the detached
 * supervisor starts. It carries everything the supervisor needs so the pipeline
 * never reads the Queue store: the exact head, the checkout paths, the resolved
 * sibling links, the run's argv and timeouts, and the caller identity echoed
 * back for the run's environment.
 */
export const qaSupervisionPlanSchema = z.object({
  schema: z.literal(QA_SUPERVISION_PLAN_SCHEMA),
  schema_version: z.literal(QA_SUPERVISION_SCHEMA_VERSION),
  runId: z.string().min(1).max(160),
  key: z.string().min(1).max(320),
  caller: z.string().min(1).max(320),
  base: z.string().min(1).max(80),
  baseBranch: z.string().min(1).max(200),
  startedAt: z.string().min(1),
  startedAtMs: z.number().int().nonnegative(),
  checkoutPath: z.string().min(1),
  externalCheckout: z.boolean().optional(),
  registeredPath: z.string().min(1),
  runRoot: z.string().min(1),
  argv: z.array(z.string()).min(1),
  /** #121: the ordered stages of a staged setting; absent falls back to one "qa" stage from argv. */
  stages: z.array(projectQaStageSchema).optional(),
  timeoutMs: z.number().int().positive(),
  /** Host authority epoch; Queue's first scheduler epoch is 1. */
  epoch: z.number().int().positive().default(1),
  runClass: z.enum(["heavy", "light"]).default("heavy"),
  hostRunStateDir: z.string().min(1).optional(),
  /** Private launch credential; stored only in this owner-only plan. */
  hostRunToken: z.string().min(1).optional(),
  maxOutputBytes: z.number().int().positive(),
  terminationGraceMs: z.number().int().min(0).max(PROCESS_TERMINATION_GRACE_MAX_MS).default(DEFAULT_PROCESS_TERMINATION_GRACE_MS),
  hookTimeoutMs: z.number().int().positive(),
  hookMaxOutputBytes: z.number().int().positive(),
  /** The run's random identity, carried in the supervisor's own argv. */
  identityToken: z.string().min(16).max(128),
  links: z.array(z.object({ name: z.string().min(1), target: z.string().min(1) }).strict()),
  /** Per-run temp leaf; absent on plans written before this field, which keep the supervisor's inherited TMPDIR. */
  temporaryDirectory: z.string().max(2000).optional(),
  /**
   * Task 134: `full` is the setup/QA/teardown pipeline. `teardown_retry` reruns
   * only the recorded teardown command in a retained checkout, appending a new
   * teardown attempt without touching setup or QA.
   */
  mode: z.enum(["full", "teardown_retry"]).default("full"),
  /** The retry attempt number; 0 for a full run or the first attempt. */
  attempt: z.number().int().nonnegative().default(0),
  /** The retry payload, present exactly on a `teardown_retry` plan. */
  retry: z.object({
    command: z.string().min(1),
    priorSteps: z.array(projectQaStepSchema),
    qaExitCode: z.number().int().nullable(),
    priorCancelReason: z.string().nullable().default(null),
    reason: z.string().min(1).max(4000),
    cleanupOnly: z.boolean().optional(),
    priorFailedStep: projectQaStepNameSchema.nullable().optional(),
  }).strict().nullable().default(null),
}).strict();
export type QaSupervisionPlan = z.infer<typeof qaSupervisionPlanSchema>;

/** The settled part of a run; a present `result` means the supervisor finished. */
export const qaSupervisionResultSchema = z.object({
  state: projectQaStateSchema,
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  detail: z.string(),
  failureIndexes: z.array(projectQaFailureIndexSchema).optional(),
  finishedAt: z.string(),
  hostResult: hostRunResultSchema.nullable().default(null),
  checkoutCleanupPending: z.boolean().optional(),
}).strict();
export type QaSupervisionResult = z.infer<typeof qaSupervisionResultSchema>;

export const qaActiveProcessSchema = z.object({
  step: projectQaStepNameSchema,
  pid: z.number().int().positive(),
  processGroupId: z.number().int().positive(),
  startIdentity: z.string().min(1),
  /** Private environment identity used to prove the group before signaling. */
  leaderStartIdentity: z.string().min(16).max(128),
  startedAt: z.string().datetime(),
}).strict();

export const qaCancelRequestSchema = z.object({
  runId: z.string().min(1).max(160),
  reason: z.string().trim().min(1).max(4000),
  requestedAt: z.string().datetime(),
}).strict();
export type QaCancelRequest = z.infer<typeof qaCancelRequestSchema>;

/**
 * #1393: one step's direct child exit, published the moment the executor sees it
 * and kept beside the run until the run settles. It is the supervisor's own
 * record of how the command it started ended, so a settlement that never lands
 * still leaves the exit code or signal, the time and the output offset behind.
 * The heartbeat is deliberately separate from it: a step that ended is not a
 * supervisor that is alive.
 */
export const QA_STEP_EXIT_SCHEMA = "queue.project-qa.step-exit.v1";

export const qaStepExitSchema = z.object({
  schema: z.literal(QA_STEP_EXIT_SCHEMA),
  schema_version: z.literal(QA_SUPERVISION_SCHEMA_VERSION),
  runId: z.string().min(1).max(160),
  step: projectQaStepNameSchema,
  /** The direct child's pid; for a detached step leader it is also its group id. */
  pid: z.number().int().positive(),
  processGroupId: z.number().int().positive(),
  exitCode: z.number().int().nullable(),
  signal: z.string().min(1).max(64).nullable(),
  exitedAt: z.string().datetime(),
}).strict().refine(exit => (exit.exitCode === null) !== (exit.signal === null), {
  message: "Exactly one of exitCode and signal must be non-null",
});
export type QaStepExit = z.infer<typeof qaStepExitSchema>;

export const qaSupervisionStateSchema = z.object({
  schema: z.literal(QA_SUPERVISION_SCHEMA),
  schema_version: z.literal(QA_SUPERVISION_SCHEMA_VERSION),
  runId: z.string().min(1).max(160),
  key: z.string().min(1).max(320),
  /** The detached supervisor's own pid. */
  pid: z.number().int().positive(),
  /** OS birth identity used to stop only this detached supervisor group. */
  supervisorStartIdentity: z.string().min(1).optional(),
  /** The run's random identity token; the live pid must run with this token. */
  identityToken: z.string().min(16).max(128),
  startedAt: z.string().min(1),
  heartbeatAt: z.string().min(1),
  /** Last durable pipeline boundary, for diagnosing a supervisor that stops. */
  phase: z.enum(["starting", "step-output", "step-logs", "tap-finalize", "teardown", "escapee-reap", "checkout-cleanup", "host-result", "result-publication", "live-output-close"]).optional(),
  /** The step currently running, so a proven-dead supervisor names what was in flight. */
  inFlight: projectQaStepNameSchema.nullable(),
  /** Published from the spawn event; pendingProcessIdentity covers the publication window. */
  activeProcess: qaActiveProcessSchema.nullable().default(null),
  /** Published before spawn so a restart can prove whether launch happened. */
  pendingProcessIdentity: z.string().min(16).max(128).nullable().default(null),
  steps: z.array(projectQaStepSchema),
  failedStep: projectQaStepNameSchema.nullable(),
  /** #136: full-output log-write failures, bounded and kept apart from the run's output detail. */
  logWriteErrors: z.array(projectQaLogWriteErrorSchema).max(PROJECT_QA_LOG_WRITE_ERRORS_MAX).default([]),
  /** The run's aggregate output detail, bounded. */
  detail: z.string(),
  /**
   * Task 191: every `not ok` block with its diagnostics plus the TAP summary
   * from the QA stages, bounded separately from `detail` so later output can
   * never evict it. Absent on supervision files written before this field and
   * empty when no QA stage reported a TAP failure.
   */
  failuresLog: z.string().optional(),
  /** Compact per-stage TAP identities, bounded independently from diagnostics. */
  failureIndexes: z.array(projectQaFailureIndexSchema).optional(),
  escapedDescendants: z.array(hostRunResultSchema.shape.escapedDescendants.element).default([]),
  cancelReason: z.string().nullable().default(null),
  result: qaSupervisionResultSchema.nullable(),
}).strict();
export type QaSupervisionState = z.infer<typeof qaSupervisionStateSchema>;

/**
 * The Queue-owned directory holding one repository key's QA runs, checkouts and
 * supervision files. The service and a detached supervisor derive the same path
 * from the run's repository key, so neither has to be told where a run lives.
 */
export function qaRunRootPath(dataDir: string, key: string): string {
  return join(dataDir, "project-qa", createHash("sha256").update(key).digest("hex").slice(0, 24));
}

/** The per-run supervision and plan paths under one repository's QA root. A retry attempt uses its own file names. */
export function qaSupervisionPaths(runRoot: string, runId: string, attempt = 0): { statePath: string; planPath: string; resultPath: string; cancelPath: string; cpuCoveragePath: string; heartbeatPath: string; stepExitPath: string } {
  const stem = attempt > 0 ? `${runId}.retry-${attempt}` : runId;
  return {
    heartbeatPath: join(runRoot, `${stem}.heartbeat.json`),
    cpuCoveragePath: join(runRoot, `${stem}.${HOST_RUN_CPU_COVERAGE_FILE}`),
    statePath: join(runRoot, `${stem}.supervisor.json`),
    planPath: join(runRoot, `${stem}.plan.json`),
    resultPath: join(runRoot, `${stem}.result.json`),
    cancelPath: join(runRoot, `${stem}.cancel.json`),
    stepExitPath: join(runRoot, `${stem}.stepexit.json`),
  };
}

/**
 * One of this run's owner-only records, or null. `machine/owned-read` owns the read
 * itself. A caller that reaps or relaunches on absence reads the typed
 * `readQaSupervision*File` instead, so a file that exists but cannot be trusted is
 * never mistaken for one that was never written.
 */
function readOwnerOnlyJson<T>(path: string, parse: (value: unknown) => T): T | null {
  const read = readOwnedJson(path, parse);
  return read.kind === "present" ? read.value : null;
}

/** What one supervision-file read found: the record, a proven absence, or a refusal with its reason. */
export type QaFileRead<T> = OwnedJsonRead<T>;

/** Write a result exactly once using a durable same-directory publication. */
export function writeHostRunResult(path: string, record: HostRunResult): HostRunResult {
  const parsed = hostRunResultSchema.parse(record);
  const existing = readHostRunResult(path, parsed.runId);
  if (existing) return existing;
  writeOwnedJson(path, parsed, { syncDirectory: "required" });
  return readHostRunResult(path, parsed.runId) ?? parsed;
}

/** Read a result without following a result-file symlink. */
export function readHostRunResult(path: string, runId?: string): HostRunResult | null {
  return readOwnerOnlyJson(path, value => {
    const record = hostRunResultSchema.parse(value);
    if (runId && record.runId !== runId) throw new Error("Result runId mismatch");
    return record;
  });
}

/** Publish the first cancellation request atomically; retries return the original reason. */
export function writeQaCancelRequest(path: string, request: QaCancelRequest): QaCancelRequest {
  const parsed = qaCancelRequestSchema.parse(request);
  const existing = readQaCancelRequest(path, parsed.runId);
  if (existing) return existing;
  try { writeOwnedJson(path, parsed, { exclusive: true, syncDirectory: "required" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = readQaCancelRequest(path, parsed.runId);
    if (winner) return winner;
    throw error;
  }
  return readQaCancelRequest(path, parsed.runId) ?? parsed;
}

export function readQaCancelRequest(path: string, runId?: string): QaCancelRequest | null {
  return readOwnerOnlyJson(path, value => {
    const request = qaCancelRequestSchema.parse(value);
    if (runId && request.runId !== runId) throw new Error("Cancel runId mismatch");
    return request;
  });
}

export function writeQaSupervisionPlan(path: string, plan: QaSupervisionPlan): void {
  writeOwnedJson(path, plan);
}

export function readQaSupervisionPlan(path: string): QaSupervisionPlan | null {
  return readOwnerOnlyJson(path, value => qaSupervisionPlanSchema.parse(value));
}

/** The plan this run's supervisor was started with, keeping absence apart from an unreadable file. */
export function readQaSupervisionPlanFile(path: string): QaFileRead<QaSupervisionPlan> {
  return readOwnedJson(path, value => qaSupervisionPlanSchema.parse(value));
}

export function writeQaSupervision(path: string, state: QaSupervisionState): void {
  // The heartbeat refreshes the whole file, so the bounded detail keeps it small
  // even when a chatty teardown printed far more than the record will keep. A
  // detail cut here says so instead of reading as the run's whole story.
  writeOwnedJson(path, { ...state, detail: tailWithTruncationMarker(state.detail, PROJECT_QA_DETAIL_BYTES) });
}

/** A heartbeat is a live observation, separate from fsynced lifecycle evidence. */
const qaHeartbeatSchema = qaSupervisionStateSchema.pick({ runId: true, pid: true, identityToken: true, heartbeatAt: true }).strict();

export function readQaHeartbeat(path: string, state: QaSupervisionState): string {
  const heartbeat = readOwnerOnlyJson(path, value => qaHeartbeatSchema.parse(value));
  return heartbeat?.runId === state.runId && heartbeat.pid === state.pid && heartbeat.identityToken === state.identityToken
    && Date.parse(heartbeat.heartbeatAt) > Date.parse(state.heartbeatAt) ? heartbeat.heartbeatAt : state.heartbeatAt;
}

/** The private CPU-reason sidecar beside the supervision state; null when missing or unreadable. */
export function readQaCpuCoverage(path: string): unknown {
  try { return parseCpuCoverageSidecar(readFileSync(path)); } catch { return null; }
}

export function readQaSupervision(path: string): QaSupervisionState | null {
  return readOwnerOnlyJson(path, value => qaSupervisionStateSchema.parse(value));
}

/**
 * #1393: one step's recorded exit, or null when nothing was written for it. The
 * caller names the step and pid it is asking about, so a record left by an
 * earlier step is never read as the current one's.
 */
export function readQaStepExit(path: string, match?: { runId?: string; step?: string; pid?: number }): QaStepExit | null {
  return readOwnerOnlyJson(path, value => {
    const exit = qaStepExitSchema.parse(value);
    if (match?.runId && exit.runId !== match.runId) throw new Error("Step-exit runId mismatch");
    if (match?.step && exit.step !== match.step) throw new Error("Step-exit step mismatch");
    if (match?.pid && exit.pid !== match.pid) throw new Error("Step-exit pid mismatch");
    return exit;
  });
}

/** The heartbeat this run's supervisor published, keeping absence apart from an unreadable file. */
export function readQaSupervisionStateFile(path: string): QaFileRead<QaSupervisionState> {
  return readOwnedJson(path, value => qaSupervisionStateSchema.parse(value));
}

/** The full-output log paths for one step, kept beside the run under the QA root. */
export function qaStepLogPaths(runRoot: string, runId: string, step: string): { stdoutPath: string; stderrPath: string } {
  return { stdoutPath: join(runRoot, `${runId}.${step}.stdout.log`), stderrPath: join(runRoot, `${runId}.${step}.stderr.log`) };
}

/**
 * The live log one QA run's terminal tab follows while it runs (task 530). Every
 * stage's output is appended as it arrives, ahead of the step logs that keep the
 * capped record, so the file an operator watches is never the run's evidence.
 */
export function qaRunLiveOutputPath(runRoot: string, runId: string): string {
  return join(runRoot, `${runId}.live.log`);
}

/** Where one live projection's output ended: its path, its byte count and its last lines. */
export interface QaOutputPointer { path: string; bytes: number; tail: string }

/** Bytes read from the end of an output log; enough for a handful of lines, never the whole log. */
const QA_OUTPUT_POINTER_BYTES = 16_384;
const QA_OUTPUT_POINTER_LINES = 12;

/**
 * #1393: read where a projected output log ended — its path, its byte offset and
 * its last lines — so a settled run names the output it stopped at instead of
 * only describing it. A missing or unreadable log is no pointer at all: absence
 * is never reported as zero bytes of output.
 */
export function readQaOutputPointer(path: string, lines = QA_OUTPUT_POINTER_LINES): QaOutputPointer | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.size <= 0) return null;
    const start = Math.max(0, info.size - QA_OUTPUT_POINTER_BYTES);
    const buffer = Buffer.alloc(Math.min(info.size, QA_OUTPUT_POINTER_BYTES));
    const read = readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, read).toString("utf8");
    const kept = text.split("\n").slice(-Math.max(1, lines)).join("\n").trimEnd();
    return { path, bytes: info.size, tail: kept };
  } catch { return null; }
  finally { if (fd !== null) closeSync(fd); }
}

/**
 * Write one stream's full output — the executor already capped it at the step's
 * maxOutputBytes and kept the tail past the cap — to a mode-0600 log beside the
 * run, returning the bytes retained. A log that cannot be written returns its
 * error instead of a byte count, so the run can report the failure rather than
 * silently showing a missing log as no output.
 */
export function writeQaStepLog(path: string, buffer: Buffer): { bytes: number | null; error: string | null } {
  try { writeFileSync(path, buffer, { mode: 0o600 }); chmodSync(path, 0o600); return { bytes: buffer.length, error: null }; }
  catch (error) { return { bytes: null, error: error instanceof Error ? error.message : String(error) }; }
}

/** Remove a settled run's per-run plan and supervision files; the store owns the record now. */
export function removeQaSupervisionFiles(runRoot: string, runId: string, attempt = 0): void {
  const { statePath, planPath, cancelPath, cpuCoveragePath, heartbeatPath, stepExitPath } = qaSupervisionPaths(runRoot, runId, attempt);
  for (const path of [statePath, planPath, cancelPath, cpuCoveragePath, heartbeatPath, stepExitPath]) rmSync(path, { force: true });
}

export interface QaFilePruningContext {
  store: Pick<Store, "qaRun" | "latestQaRun">;
  hostRuns: Pick<HostRunScheduler, "get">;
  needsTeardownRetry(run: ProjectQaRun): boolean;
  historyRetentionMs: number;
}

export const projectQaFilePruning = {
  /** Only recognized per-run files expire; active and retryable runs retain their evidence. */
  async pruneQaFiles(this: QaFilePruningContext, roots: string[]): Promise<void> {
    const cutoff = Date.now() - this.historyRetentionMs;
    for (const root of new Set(roots)) {
      const qaRoot = join(root, "project-qa");
      for (const digestEntry of await readdir(qaRoot, { withFileTypes: true }).catch(() => [])) {
        if (!digestEntry.isDirectory() || !/^[a-f0-9]{24}$/.test(digestEntry.name)) continue;
        const directory = join(qaRoot, digestEntry.name);
        for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
          const match = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.(?:retry-\d+\.)?(?:.*\.(?:log|json)|(?:stdout|stderr)\.log)$/.exec(entry.name);
          if (!match || !entry.isFile()) continue;
          const run = this.store.qaRun(match[1]);
          if (run && (run.state === "running" || run.state === "queued" || run.checkoutCleanupPending
            || this.needsTeardownRetry(run) && this.store.latestQaRun(run.key)?.id === run.id
            || !run.finishedAt || Date.parse(run.finishedAt) >= cutoff)) continue;
          const hostRun = this.hostRuns.get(match[1]);
          if (hostRun && hostRun.state !== "settled") continue;
          const path = join(directory, entry.name);
          try {
            const info = await lstat(path);
            if (info.isFile() && info.mtimeMs < cutoff) await unlink(path);
          } catch { /* Retain uncertain files for the next sweep. */ }
        }
      }
    }
  }

};
