/**
 * Task 134: rerun only a settled run's failed teardown, through the same
 * supervisor, termination and logging path as the original. Refused unless the
 * run settled at teardown, its Queue-owned checkout is retained and no
 * supervisor is live. The recorded QA step is never rerun or rewritten: the
 * prior steps are carried verbatim and only a new attempt-numbered teardown
 * step is appended.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { now } from "../store/store";
import { DEFAULT_PROCESS_TERMINATION_GRACE_MS, projectQaRunSchema, type ProjectQaRun, type ProjectQaStep, type ProjectQaStepName, type HostRunEscapedDescendant, type ProjectQaLogWriteError } from "../../shared/contracts";
import type { HostRunScheduler } from "../host-runs/host-run-scheduler";
import { tailWithTruncationMarker } from "../machine/output-retention";
import {
  QA_SUPERVISION_PLAN_SCHEMA, QA_SUPERVISION_SCHEMA_VERSION, qaSupervisionPaths,
  qaSupervisionPlanSchema, removeQaSupervisionFiles, writeQaSupervisionPlan, type QaSupervisionState,
} from "./project-qa-supervision-files";
import { mergeLogWriteErrors, mergeQaEscapees } from "./project-qa-pipeline";
import { projectQaWorktreeHooks } from "./project-qa-worktree";
import { DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES, DEFAULT_PROJECT_QA_TIMEOUT_MS, PROJECT_QA_TAIL_BYTES } from "./project-qa-defaults";
import { qaLaunchGates } from "./project-qa-gates";
import type { ProjectQaOptions } from "./project-qa-context";
import type { Store } from "../store/store";

export interface QaTeardownRetryContext {
  store: Store;
  hostRuns: HostRunScheduler;
  options: Pick<ProjectQaOptions, "logWrite">;
  qaCallerIdentity(key: string, runId: string): string;
  qaRepositoryRootPath(key: string): string;
  hostRunStateDir(): string;
  checkoutForRun(run: ProjectQaRun): string;
  admitCheckout(run: ProjectQaRun): void;
  ensureRunScratch(run: ProjectQaRun): string | undefined;
  releaseRunScratch(run: ProjectQaRun, checkoutRetained: boolean): void;
  spawnQaSupervisor(planPath: string, identityToken: string, temporaryDirectory?: string): number;
  attachSupervisor(runId: string, key: string, unstartedResumes?: number): Promise<ProjectQaRun>;
  liveSupervisorFor(run: ProjectQaRun): boolean;
  startTeardownRetry(run: ProjectQaRun, command: string, qaExitCode: number | null, reason: string, cleanupOnly: boolean): Promise<ProjectQaRun>;
  settleTeardownRetry(run: ProjectQaRun, state: QaSupervisionState | null): ProjectQaRun;
  applyTeardownRetry(run: ProjectQaRun, outcome: {
    state: ProjectQaRun["state"]; exitCode: number | null; detail: string; finishedAt: string;
    steps: ProjectQaStep[]; failedStep: ProjectQaStepName | null; escapedDescendants: HostRunEscapedDescendant[];
    logWriteErrors?: ProjectQaLogWriteError[];
    checkoutCleanupPending?: boolean;
    interruptedStep?: ProjectQaStepName | null;
  }): ProjectQaRun;
}

export const projectQaTeardownRetry = {
  /** Request one teardown rerun for a settled run that failed at teardown. */
  async retryTeardown(this: QaTeardownRetryContext, input: { id: string; reason: string }): Promise<ProjectQaRun> {
    const reason = input.reason.trim();
    if (!input.id.trim() || !reason) throw new Error("Project QA teardown retry requires a run id and reason");
    const run = this.store.qaRun(input.id);
    if (!run) throw new Error(`Project QA run not found: ${input.id}`);
    if (run.state === "queued" || run.state === "running")
      throw new Error(`Project QA run ${run.id} is ${run.state}; teardown retry needs a settled run`);
    const lastTeardown = run.steps.filter(step => step.name === "teardown").at(-1);
    const teardownFailed = Boolean(lastTeardown && (lastTeardown.exitCode !== 0 || lastTeardown.signal != null
      || lastTeardown.timedOut || lastTeardown.terminationError != null || lastTeardown.processGroupEmpty === false));
    if (run.failedStep !== "teardown" && !teardownFailed && !run.checkoutCleanupPending)
      throw new Error(`Project QA run ${run.id} did not fail at teardown; teardown retry is refused`);
    if (run.interruptedStep === "teardown")
      throw new Error(`Project QA run ${run.id} has an uncertain teardown outcome; retry is refused`);
    const checkoutPath = this.checkoutForRun(run);
    this.admitCheckout(run);
    if (!existsSync(checkoutPath))
      throw new Error(`Project QA run ${run.id} has no retained checkout; teardown retry is refused`);
    if (this.liveSupervisorFor(run))
      throw new Error(`Project QA run ${run.id} still has a live supervisor; teardown retry is refused`);
    const hook = lastTeardown ? null : (await projectQaWorktreeHooks(checkoutPath)).teardown;
    const cleanupOnly = Boolean(run.checkoutPath && run.checkoutCleanupPending);
    const command = lastTeardown?.command ?? hook ?? (cleanupOnly ? ":" : null);
    if (!command)
      throw new Error(`Project QA run ${run.id} records no teardown command; teardown retry is refused`);
    const qaExitCode = run.steps.find(step => step.name === "qa")?.exitCode ?? run.exitCode;
    const start = this.startTeardownRetry(run, command, qaExitCode, reason, cleanupOnly);
    const gate = start.finally(() => { qaLaunchGates.delete(run.key); });
    qaLaunchGates.set(run.key, gate);
    return await gate;
  },

  /** Spawn the detached supervisor for one teardown retry attempt and watch it settle. */
  async startTeardownRetry(this: QaTeardownRetryContext, run: ProjectQaRun, command: string, qaExitCode: number | null, reason: string, cleanupOnly: boolean): Promise<ProjectQaRun> {
    const runRoot = this.qaRepositoryRootPath(run.key);
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    const attempt = (run.teardownRetryAttempt ?? 0) + 1;
    const identityToken = randomUUID();
    const startedAt = now();
    const temporaryDirectory = this.ensureRunScratch(run);
    const plan = qaSupervisionPlanSchema.parse({
      schema: QA_SUPERVISION_PLAN_SCHEMA, schema_version: QA_SUPERVISION_SCHEMA_VERSION,
      runId: run.id, key: run.key, caller: this.qaCallerIdentity(run.key, run.id),
      base: run.base, baseBranch: run.baseBranch, startedAt, startedAtMs: Date.parse(startedAt),
      checkoutPath: this.checkoutForRun(run), registeredPath: run.repository.path, runRoot,
      ...(run.checkoutPath ? { externalCheckout: true } : {}),
      argv: run.argv, timeoutMs: run.runTimeoutMs ?? DEFAULT_PROJECT_QA_TIMEOUT_MS,
      maxOutputBytes: run.maxOutputBytes ?? DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES,
      epoch: run.hostRunEpoch ?? this.hostRuns.authority().epoch,
      runClass: run.runClass ?? "heavy", hostRunStateDir: this.hostRunStateDir(),
      terminationGraceMs: run.terminationGraceMs ?? DEFAULT_PROCESS_TERMINATION_GRACE_MS,
      hookTimeoutMs: DEFAULT_PROJECT_QA_TIMEOUT_MS, hookMaxOutputBytes: DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES,
      identityToken, links: [], mode: "teardown_retry", attempt,
      retry: { command, priorSteps: run.steps, qaExitCode, priorCancelReason: run.cancelReason, reason, cleanupOnly, priorFailedStep: run.failedStep, priorInterruptedStep: run.interruptedStep },
      ...(temporaryDirectory ? { temporaryDirectory } : {}),
    });
    const { planPath } = qaSupervisionPaths(runRoot, run.id, attempt);
    writeQaSupervisionPlan(planPath, plan);
    const current = this.store.qaRun(run.id) ?? run;
    // Mark the run running before the spawn, so a roll in the launch window
    // leaves a running row the next service reconciles rather than a silent hold.
    this.store.putQaRun({ ...current, state: "running", pid: null, finishedAt: null, teardownRetryAttempt: attempt });
    const pid = this.spawnQaSupervisor(planPath, identityToken, temporaryDirectory);
    const running = this.store.putQaRun({ ...(this.store.qaRun(run.id) ?? current), pid });
    void this.attachSupervisor(running.id, running.key).catch(() => { /* the watcher records its own fault on the run */ });
    return running;
  },

  /**
   * Apply a teardown retry's outcome to the run record. Only state, exit code,
   * detail, finished time and steps change: the QA step is carried verbatim in
   * `steps`, and the run's base, Queue settlement and duration stay.
   */
  applyTeardownRetry(this: QaTeardownRetryContext, run: ProjectQaRun, outcome: {
    state: ProjectQaRun["state"]; exitCode: number | null; detail: string; finishedAt: string;
    steps: ProjectQaStep[]; failedStep: ProjectQaStepName | null; escapedDescendants: HostRunEscapedDescendant[];
    logWriteErrors?: ProjectQaLogWriteError[];
    checkoutCleanupPending?: boolean;
    interruptedStep?: ProjectQaStepName | null;
  }): ProjectQaRun {
    const escapedDescendants = mergeQaEscapees(run.escapedDescendants ?? [], outcome.escapedDescendants ?? []);
    const saved = this.store.putQaRun(projectQaRunSchema.parse({
      ...run, state: outcome.state, exitCode: outcome.exitCode,
      outputTail: tailWithTruncationMarker(outcome.detail, PROJECT_QA_TAIL_BYTES), finishedAt: outcome.finishedAt, pid: null,
      steps: outcome.steps, failedStep: outcome.failedStep, interruptedStep: outcome.interruptedStep ?? null, escapedDescendants,
      ...(run.checkoutPath ? { checkoutCleanupPending: outcome.checkoutCleanupPending ?? false } : {}),
      logWriteErrors: mergeLogWriteErrors(run.logWriteErrors, outcome.logWriteErrors),
    }));
    this.releaseRunScratch(saved, Boolean(saved.checkoutCleanupPending));
    return saved;
  },

  /** Apply a settled teardown retry supervisor's durable result to the run record. */
  settleTeardownRetry(this: QaTeardownRetryContext, run: ProjectQaRun, state: QaSupervisionState | null): ProjectQaRun {
    const result = state?.result;
    if (!result) return run;
    const current = this.store.qaRun(run.id) ?? run;
    const settled = this.applyTeardownRetry(current, {
      state: result.state, exitCode: result.exitCode, detail: result.detail, finishedAt: result.finishedAt,
      steps: state?.steps ?? current.steps, failedStep: state?.failedStep ?? current.failedStep,
      checkoutCleanupPending: result.checkoutCleanupPending,
      interruptedStep: result.state === "hold" && current.interruptedStep && current.interruptedStep !== "teardown"
        ? current.interruptedStep : null,
      escapedDescendants: state?.escapedDescendants ?? current.escapedDescendants,
      logWriteErrors: state?.logWriteErrors ?? [],
    });
    removeQaSupervisionFiles(this.qaRepositoryRootPath(current.key), current.id, current.teardownRetryAttempt ?? 0);
    return settled;
  },
};
