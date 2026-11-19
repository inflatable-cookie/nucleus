/**
 * Task 114/134: settle a run whose detached supervisor is proven dead, or a run
 * whose teardown retry died. The steps it recorded are kept, the step that was
 * in flight is named, the real duration comes from `startedAt`, and teardown
 * still runs from the retained checkout (unless the supervisor had already
 * completed it) with its own step record.
 */
import { existsSync } from "node:fs";
import { minimalHookEnvironment, type ExecutionOutcome } from "../hooks/hooks";
import { gitText } from "../workspaces/worktree-links";
import { withRunTemporaryDirectory } from "../workspaces/run-scratch";
import { findGitWorktreeAdd, findProcessByCommandToken } from "../machine/process-identity";
import { supervisorLiveness } from "../machine/start-identity";
import { parseWorktreeList, repoCommonDir } from "../workspaces/workspace-allocation";
import { tailWithTruncationMarker } from "../machine/output-retention";
import { now, type Store } from "../store/store";
import type { HostRunEscapedDescendant, ProjectQaLogWriteError, ProjectQaRun, ProjectQaStep, ProjectQaStepName } from "../../shared/contracts";
import {
  qaRunLiveOutputPath, qaStepLogPaths, qaSupervisionPaths, readQaOutputPointer, readQaSupervisionPlan, readQaSupervision, readQaPhase,
  removeQaSupervisionFiles, writeQaStepLog,
  type QaSupervisionState,
} from "./project-qa-supervision-files";
import {
  executionOutput, mergeQaEscapees, mergeLogWriteErrors, qaExecutionFailed, qaStepRecord,
  type QaPipelineOutcome,
} from "./project-qa-pipeline";
import { projectQaWorktreeHooks, removeQaWorkspace } from "./project-qa-worktree";
import { PROJECT_QA_TAIL_BYTES } from "./project-qa-defaults";
import { hostRunResultSchema, type HostRunResult } from "../../shared/contracts";
import { hostRunProcessStartIdentity } from "../machine/start-identity";
import type { SupervisorInspection } from "./project-qa-inspection";

export interface QaRecoveryContext {
  store: Pick<Store, "qaRun" | "putQaRun" | "transaction">;
  qaRepositoryRootPath(key: string): string;
  checkoutForRun(run: ProjectQaRun): string;
  admitCheckout(run: ProjectQaRun): void;
  runWorktreeHook(root: string, script: string, terminationGraceMs?: number,
    options?: { env?: Record<string, string> }): Promise<ExecutionOutcome>;
  settle(run: ProjectQaRun, outcome: QaPipelineOutcome & { interruptedStep: ProjectQaStepName | null }): Promise<ProjectQaRun>;
  /** Prove a retained checkout is exactly this run's own. */
  retainedCheckoutIdentity(run: ProjectQaRun, checkoutPath: string): Promise<void>;
  /** Apply one settled teardown retry attempt to the run record. */
  applyTeardownRetry(run: ProjectQaRun, outcome: {
    state: ProjectQaRun["state"]; exitCode: number | null; detail: string; finishedAt: string;
    steps: ProjectQaStep[]; failedStep: ProjectQaStepName | null; escapedDescendants: HostRunEscapedDescendant[];
    logWriteErrors?: ProjectQaLogWriteError[];
    checkoutCleanupPending?: boolean;
  }): ProjectQaRun;
  /** Settle a run whose supervisor is proven dead, from what it recorded. */
  reconcileLostRun(run: ProjectQaRun, state: QaSupervisionState | null, reason: string, escapedDescendants?: HostRunEscapedDescendant[]): Promise<void>;
  /** Settle an abandoned run: teardown, checkout release and the durable record. */
  settleAbandoned(run: ProjectQaRun, state: QaSupervisionState | null, settlement: QaAbandonedSettlement, escapedDescendants?: HostRunEscapedDescendant[]): Promise<void>;
  /** Keep an output pointer on the settled record. */
  appendSettledOutputPointer(run: ProjectQaRun, output: string): Promise<void>;
}

/**
 * One abandoned run's settlement: the supervisor is gone, so the run settles on
 * what the run itself recorded. `lost` is the dead supervisor's outcome and
 * `failed` is the ended step's, and both travel through the same teardown and
 * checkout release so neither family can forget one of them.
 */
export interface QaAbandonedSettlement {
  state: "lost" | "failed";
  exitCode: number | null;
  /** The step the settlement lands on, when the evidence names one. */
  interruptedStep: ProjectQaStepName | null;
  /** Additional step evidence to record before the closing sentence. */
  steps?: ProjectQaStep[];
  failedStep?: ProjectQaStepName;
  /** What happened, kept after the recorded output. */
  account: string;
  /** The closing sentence that names the settlement. */
  closing: string;
  /** The host result this settlement records, when the run's own evidence names one. */
  hostResult: HostRunResult | null;
}

/**
 * Where this step's output ended: the live projection's path and byte offset
 * with its last lines, or the step's own stream byte counts when no live log
 * survived. Evidence, never a claim about the bytes it does not hold.
 */
export function qaOutputPointerDetail(runRoot: string, runId: string, step: ProjectQaStepName): string {
  const live = readQaOutputPointer(qaRunLiveOutputPath(runRoot, runId));
  const lines = [`Live output log: ${qaRunLiveOutputPath(runRoot, runId)}${live ? ` at byte ${live.bytes}` : " (no readable live log)"}.`];
  if (live?.tail) lines.push(`Last output lines:\n${live.tail}`);
  lines.push("The supervisor did not close the live log normally; up to the run token's length in final bytes may have been withheld by redaction.");
  lines.push(`No step log for ${step} was written; the live log is the run's output record.`);
  return lines.join("\n");
}

export const projectQaRecovery = {
  /** Prove (or refuse to guess) that a retained checkout is exactly this run's own. */
  async retainedCheckoutIdentity(this: Pick<QaRecoveryContext, "store">, run: ProjectQaRun, checkoutPath: string): Promise<void> {
    if (run.checkoutPath) {
      if (findGitWorktreeAdd(checkoutPath).state !== "absent") throw Error("Project QA checkout creation remains uncertain");
      const listing = parseWorktreeList(await gitText(run.repository.path, "worktree", "list", "--porcelain"));
      const matching = listing.filter(tree => tree.path === checkoutPath);
      if (existsSync(checkoutPath) && (matching.length !== 1 || matching[0].head !== run.base || matching[0].branch ||
          await repoCommonDir(checkoutPath) !== await repoCommonDir(run.repository.path)))
        throw Error("Project QA retained checkout identity is uncertain");
      if (!existsSync(checkoutPath) && matching.length) throw Error("Project QA checkout disappearance is uncertain");
    }
  },

  async reconcileLostRun(this: QaRecoveryContext, run: ProjectQaRun, state: QaSupervisionState | null, reason: string, escapedDescendants: HostRunEscapedDescendant[] = []): Promise<void> {
    const interruptedStep = state?.inFlight ?? null;
    await this.settleAbandoned(run, state, {
      state: "lost", exitCode: null, interruptedStep, hostResult: null,
      account: `${interruptedStep ? `The ${interruptedStep} step was in flight when the supervisor died. ` : ""}Last supervisor phase: ${readQaPhase(qaSupervisionPaths(this.qaRepositoryRootPath(run.key), run.id, run.teardownRetryAttempt ?? 0).phasePath, run.id) ?? "unknown"}; supervisor exit code or signal: unknown. The live log may be missing up to the run token's length in final bytes.`,
      closing: `Queue backend lost this QA run (${reason}).`,
    }, escapedDescendants);
  },

  /**
   * #1393: settle a run whose step's process group ended and whose supervisor
   * never wrote a settlement, from the step's own recorded exit. The step that
   * ended becomes the failing step, its signal or exit code reaches the host
   * settlement, and the output pointer names where the run's output stopped.
   *
   * With no recorded exit at all the outcome is genuinely unobservable, so the
   * run settles `lost` — with the same step, output pointer and bound evidence,
   * which is exactly what the incident lacked.
   */
  async settleEndedStep(this: QaRecoveryContext, run: ProjectQaRun, inspection: Extract<SupervisorInspection, { kind: "step_ended" }>): Promise<void> {
    const { state, step, exit, reason } = inspection;
    const output = qaOutputPointerDetail(this.qaRepositoryRootPath(run.key), run.id, step);
    if (!exit) {
      await this.reconcileLostRun(run, state, reason, state.escapedDescendants);
      await this.appendSettledOutputPointer(run, output);
      return;
    }
    const startedAt = state.activeProcess?.startedAt ?? run.startedAt;
    const wallMs = Math.max(0, Date.parse(exit.exitedAt) - Date.parse(startedAt));
    const hostResult = hostRunResultSchema.parse({
      format: "host.run.result", version: 1, runId: run.id, epoch: run.hostRunEpoch ?? 1,
      pgid: exit.processGroupId,
      startIdentity: state.activeProcess?.startIdentity ?? hostRunProcessStartIdentity(exit.pid),
      exitCode: exit.signal ? null : exit.exitCode, signal: exit.signal,
      startedAt, endedAt: exit.exitedAt, wallMs, cpuMs: null, escapedDescendants: [],
    });
    const endedStep = state.steps.some(step => step.name === exit.step) ? undefined
      : qaStepRecord(exit.step, run.argv.join(" "), {
        pid: exit.pid, code: exit.exitCode, signal: exit.signal, timedOut: false,
        stdoutExceeded: false, stderrExceeded: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
        durationMs: wallMs, startedAt, endedAt: exit.exitedAt,
        processGroupId: exit.processGroupId, leaderStartIdentity: state.activeProcess?.leaderStartIdentity ?? null,
        startIdentity: state.activeProcess?.startIdentity ?? null,
        processGroupEmpty: true, terminationSignal: null, terminationError: null, escapedDescendants: [],
      }, qaStepLogPaths(this.qaRepositoryRootPath(run.key), run.id, exit.step),
        { bytes: null, error: null }, { bytes: null, error: null });
    await this.settleAbandoned(run, state, {
      state: "failed", exitCode: exit.signal ? null : exit.exitCode,
      interruptedStep: exit.step, hostResult,
      ...(endedStep ? { steps: [...state.steps, endedStep], failedStep: exit.step } : { failedStep: state.failedStep ?? exit.step }),
      account: `The supervisor left this run unsettled: ${reason}. Last supervisor phase: ${readQaPhase(qaSupervisionPaths(this.qaRepositoryRootPath(run.key), run.id).phasePath, run.id) ?? "unknown"}; supervisor exit code or signal: unknown.\n${output}`,
      closing: "Queue settled this run failed from the step's own recorded exit; it is not lost, because the step's exit code or signal and its output were recorded.",
    }, state.escapedDescendants);
  },

  /** Keep the output pointer on a settlement that could not carry it in its own accounting. */
  async appendSettledOutputPointer(this: Pick<QaRecoveryContext, "store">, run: ProjectQaRun, output: string): Promise<void> {
    const current = this.store.qaRun(run.id);
    if (!current || !output || current.outputTail.includes(output)) return;
    this.store.putQaRun({ ...current, outputTail: tailWithTruncationMarker(`${current.outputTail}\n${output}`, PROJECT_QA_TAIL_BYTES) });
  },

  /** One owner for an abandoned run's teardown, checkout release and settlement. */
  async settleAbandoned(this: QaRecoveryContext, run: ProjectQaRun, state: QaSupervisionState | null,
    settlement: QaAbandonedSettlement, escapedDescendants: HostRunEscapedDescendant[] = []): Promise<void> {
    const runRoot = this.qaRepositoryRootPath(run.key);
    const attempt = run.teardownRetryAttempt ?? 0;
    const closed = `${settlement.account ? `${settlement.account}\n` : ""}${settlement.closing}`;
    // A dead teardown-retry supervisor is not re-driven here: settle the run
    // back to hold with what the retry recorded and let the operator retry.
    if (attempt > 0) {
      const steps: ProjectQaStep[] = state ? [...state.steps] : [...run.steps];
      const detail = `${state?.detail ?? run.outputTail}${state?.detail || run.outputTail ? "\n" : ""}${closed}`;
      const current = this.store.qaRun(run.id);
      if (current?.state === "running") this.store.transaction(() => {
        const held = this.applyTeardownRetry(current, {
          state: "hold", exitCode: current.exitCode, detail, finishedAt: now(), steps,
          failedStep: "teardown",
          checkoutCleanupPending: current.checkoutCleanupPending,
          logWriteErrors: mergeLogWriteErrors(run.logWriteErrors, state?.logWriteErrors),
          escapedDescendants: mergeQaEscapees(escapedDescendants, state?.escapedDescendants ?? []),
        });
        if (state?.inFlight === "teardown") this.store.putQaRun({ ...held, interruptedStep: "teardown",
          outputTail: tailWithTruncationMarker(`${held.outputTail}\nTeardown delivery is uncertain; do not replay it.`, PROJECT_QA_TAIL_BYTES) });
      });
      removeQaSupervisionFiles(runRoot, run.id, attempt);
      return;
    }
    const checkoutPath = this.checkoutForRun(run);
    this.admitCheckout(run);
    await this.retainedCheckoutIdentity(run, checkoutPath);
    if (state?.inFlight === "teardown") throw Error("Project QA teardown delivery is uncertain; inspect the retained checkout");
    const steps: ProjectQaStep[] = settlement.steps ?? (state ? [...state.steps] : [...run.steps]);
    let failedStep: ProjectQaStepName | null = settlement.failedStep ?? state?.failedStep ?? run.failedStep;
    let detail = state?.detail ?? run.outputTail;
    let logWriteErrors = mergeLogWriteErrors(run.logWriteErrors, state?.logWriteErrors);
    let teardownFailed = false;
    if (existsSync(checkoutPath) && !steps.some(step => step.name === "teardown")) {
      try {
        const hooks = await projectQaWorktreeHooks(checkoutPath);
        if (hooks.teardown) {
          const result = await this.runWorktreeHook(checkoutPath, hooks.teardown, run.terminationGraceMs, {
            ...(run.temporaryDirectory ? { env: withRunTemporaryDirectory(minimalHookEnvironment(`project-qa:${run.id}`), run.temporaryDirectory) } : {}),
          });
          const logs = qaStepLogPaths(runRoot, run.id, "teardown");
          const stdoutLog = writeQaStepLog(logs.stdoutPath, result.stdout);
          const stderrLog = writeQaStepLog(logs.stderrPath, result.stderr);
          if (stdoutLog.error) {
            detail += `\nFull-output log for step teardown (stdout) could not be written: ${stdoutLog.error}`;
            logWriteErrors = mergeLogWriteErrors(logWriteErrors, [{ step: "teardown", stream: "stdout", error: stdoutLog.error }]);
          }
          if (stderrLog.error) {
            detail += `\nFull-output log for step teardown (stderr) could not be written: ${stderrLog.error}`;
            logWriteErrors = mergeLogWriteErrors(logWriteErrors, [{ step: "teardown", stream: "stderr", error: stderrLog.error }]);
          }
          steps.push(qaStepRecord("teardown", hooks.teardown, result, logs, stdoutLog, stderrLog));
          if (qaExecutionFailed(result)) failedStep ??= "teardown";
          const output = executionOutput(result);
          if (output) detail += `\nWorktree teardown output:\n${output}`;
          if (qaExecutionFailed(result)) {
            teardownFailed = true;
            detail += `\nQA worktree teardown failed${result.timedOut ? " (timed out)" : result.signal ? ` (${result.signal})` : ` (exit ${result.code})`}.`;
          }
        }
      } catch (error) {
        teardownFailed = true;
        detail += `\nQA worktree teardown failed: ${String(error)}`;
      }
    }
    if (!teardownFailed) {
      try {
        await removeQaWorkspace({ registeredPath: run.repository.path, checkoutPath,
          ...(run.checkoutPath ? { admission: () => this.admitCheckout(run), expectedHead: run.base } : {}) });
        detail += " Its Queue-owned checkout was removed.";
      } catch (error) {
        detail += `\nQA checkout cleanup failed: ${String(error)}`;
      }
    }
    detail = `${detail}${detail ? "\n" : ""}${closed}`;
    const durationMs = Math.max(0, Date.now() - Date.parse(run.startedAt));
    const current = this.store.qaRun(run.id);
    if (current?.state === "running") await this.settle(current, {
      state: settlement.state, exitCode: settlement.exitCode, durationMs, detail, steps, failedStep, logWriteErrors,
      finishedAt: now(), interruptedStep: settlement.interruptedStep, hostResult: settlement.hostResult,
      escapedDescendants: mergeQaEscapees(escapedDescendants, state?.escapedDescendants ?? []),
      cancelReason: state?.cancelReason ?? current.cancelReason,
    });
    removeQaSupervisionFiles(runRoot, run.id);
  },

  /**
   * True while any recorded supervisor for this run is still alive. A settled
   * run's retained result file is not evidence of life, so only the recorded
   * pid plus identity token (and the plan's token) are consulted. An identity
   * that cannot be read counts as live, matching the re-attach rule.
   */
  liveSupervisorFor(this: QaRecoveryContext, run: ProjectQaRun): boolean {
    const runRoot = this.qaRepositoryRootPath(run.key);
    for (const attempt of new Set([0, run.teardownRetryAttempt ?? 0])) {
      const { statePath, planPath } = qaSupervisionPaths(runRoot, run.id, attempt);
      const state = readQaSupervision(statePath);
      if (state && supervisorLiveness(state.pid, state.identityToken).state !== "dead") return true;
      const plan = readQaSupervisionPlan(planPath);
      if (plan?.runId === run.id && plan.key === run.key && findProcessByCommandToken(plan.identityToken).state !== "absent") return true;
    }
    return false;
  },
};
