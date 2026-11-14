import { existsSync } from "node:fs";
import {
  type ProjectQaRun,
  type ProjectQaStep,
  type ProjectQaStepName,
} from "../../shared/contracts";
import {
  QA_SUPERVISION_SCHEMA,
  QA_SUPERVISION_SCHEMA_VERSION,
  qaStepLogPaths,
  writeQaStepLog,
  type QaSupervisionState,
} from "./project-qa-supervision-files";
import {
  mergeQaEscapees, qaExecutionFailed, qaStepRecord, executionOutput, recordLogWriteError, reapPipelineEscapees,
  type QaPipelineIdentity, type QaPipelineIo, type QaPipelineOutcome, type QaPipelineRun,
} from "./project-qa-pipeline";
import { removeQaWorkspace } from "./project-qa-worktree";

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

