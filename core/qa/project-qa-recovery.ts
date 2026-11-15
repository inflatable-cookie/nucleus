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
  qaStepLogPaths, qaSupervisionPaths, readQaSupervisionPlan, readQaSupervision, removeQaSupervisionFiles, writeQaStepLog,
  type QaSupervisionState,
} from "./project-qa-supervision-files";
import {
  executionOutput, mergeQaEscapees, mergeLogWriteErrors, qaExecutionFailed, qaStepRecord,
  type QaPipelineOutcome,
} from "./project-qa-pipeline";
import { projectQaWorktreeHooks, removeQaWorkspace } from "./project-qa-worktree";
import { PROJECT_QA_TAIL_BYTES } from "./project-qa-defaults";

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
    const runRoot = this.qaRepositoryRootPath(run.key);
    const attempt = run.teardownRetryAttempt ?? 0;
    // A dead teardown-retry supervisor is not re-driven here: settle the run
    // back to hold with what the retry recorded and let the operator retry.
    if (attempt > 0) {
      const steps: ProjectQaStep[] = state ? [...state.steps] : [...run.steps];
      const detail = `${state?.detail ?? run.outputTail}${state?.detail || run.outputTail ? "\n" : ""}Queue lost this QA run (${reason}).`;
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
    const steps: ProjectQaStep[] = state ? [...state.steps] : [...run.steps];
    let failedStep: ProjectQaStepName | null = state?.failedStep ?? run.failedStep;
    const interruptedStep = state?.inFlight ?? null;
    let detail = state?.detail ?? run.outputTail;
    detail = `${detail}${detail ? "\n" : ""}Queue backend lost this QA run (${reason}).`;
    if (interruptedStep) detail = `${detail}${detail ? " " : ""}The ${interruptedStep} step was in flight when the supervisor died.`;
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
    const durationMs = Math.max(0, Date.now() - Date.parse(run.startedAt));
    const current = this.store.qaRun(run.id);
    if (current?.state === "running") await this.settle(current, {
      state: "lost", exitCode: null, durationMs, detail, steps, failedStep, logWriteErrors,
      finishedAt: now(), interruptedStep, hostResult: null,
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
