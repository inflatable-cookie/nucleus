/**
 * Task 104/114: apply one durable QA result to the run record and the host-run
 * envelope. One owner of the settled shape: state, exit code, duration, steps,
 * failure inventory, escaped descendants, the host settlement and the settlement
 * notice. Nothing here starts or stops work.
 */
import { gitText } from "../workspaces/worktree-links";
import { tailWithTruncationMarker } from "../machine/output-retention";
import { processStartIdentityLiveness } from "../machine/process-identity-search";
import { now, type Store } from "../store/store";
import {
  boundCpuCoverage, hostRunSettlementSchema, projectQaRunSchema,
  type HostRunResult, type HostRunSettlement, type ProjectQaRun, type ProjectQaStepName,
} from "../../shared/contracts";
import type { HostRunScheduler } from "../host-runs/host-run-scheduler";
import { projectQaNotice, uniqueProjectQaRecipients } from "./project-qa-notice";
import {
  qaSupervisionPaths, readQaCancelRequest, readQaCpuCoverage, removeQaSupervisionFiles,
  type QaSupervisionState,
} from "./project-qa-supervision-files";
import { qaSupervisionCpuCoverage, type QaPipelineOutcome } from "./project-qa-pipeline";
import { PROJECT_QA_TAIL_BYTES } from "./project-qa-defaults";
import type { ProjectQaOptions } from "./project-qa-context";

export interface QaSettleContext {
  store: Store;
  hostRuns: HostRunScheduler;
  options: Pick<ProjectQaOptions, "notify">;
  qaRepositoryRootPath(key: string): string;
  watchEscapedDescendants(runId: string): void;
  releaseRunScratch(run: ProjectQaRun, checkoutRetained: boolean): void;
  settleTeardownRetry(run: ProjectQaRun, state: QaSupervisionState | null): ProjectQaRun;
  publishCommandLaunchIdentity(run: ProjectQaRun, state: QaSupervisionState | null, hostResult: HostRunResult | null): void;
  notifySettled(saved: ProjectQaRun): Promise<ProjectQaRun>;
  settle(run: ProjectQaRun, outcome: QaPipelineOutcome & { interruptedStep: ProjectQaStepName | null }): Promise<ProjectQaRun>;
}

export const projectQaSettlement = {
  /** Settle the Queue record and scheduler envelope from the supervisor's durable result. */
  async settle(this: QaSettleContext, run: ProjectQaRun, outcome: QaPipelineOutcome & { interruptedStep: ProjectQaStepName | null }): Promise<ProjectQaRun> {
    let state = outcome.state;
    let detail = outcome.detail;
    const scheduled = this.hostRuns.get(run.id);
    const capacityUnavailable = scheduled?.settlement?.outcome === "capacity_timeout";
    if (capacityUnavailable && state === "failed") {
      state = "hold";
      detail = `QA capacity unavailable: ${detail}`;
    }
    const current = this.store.qaRun(run.id) ?? run;
    const hostResult = outcome.hostResult ?? null;
    const escapedDescendants = outcome.escapedDescendants ?? hostResult?.escapedDescendants ?? current.escapedDescendants;
    const launched = Boolean(scheduled?.launchedAt) || Boolean(hostResult) || state === "lost" || outcome.steps.some(step => Boolean(step.processGroupId));
    const hostOutcome: HostRunSettlement["outcome"] = capacityUnavailable && !launched ? "capacity_timeout"
      : state === "passed" ? "passed"
        : state === "cancelled" ? "cancelled"
          : state === "timed_out" ? "timed_out"
            : state === "lost" ? "lost"
              : "failed";
    let hostSettlement: HostRunSettlement | null = scheduled?.settlement ?? null;
    if (!hostSettlement && !launched && (hostOutcome === "cancelled" || hostOutcome === "capacity_timeout")) {
      hostSettlement = hostRunSettlementSchema.parse({ format: "host.run.settlement", version: 1, runId: run.id,
        outcome: hostOutcome, launched: false, settledAt: outcome.finishedAt, result: null, containers: [] });
    } else if (!hostSettlement && launched && hostOutcome === "lost") {
      hostSettlement = hostRunSettlementSchema.parse({ format: "host.run.settlement", version: 1, runId: run.id,
        outcome: "lost", launched: true, settledAt: outcome.finishedAt, result: null, containers: [] });
    } else if (!hostSettlement && launched && hostResult) {
      const normalizedOutcome = state === "hold" ? "failed" : hostOutcome;
      hostSettlement = hostRunSettlementSchema.parse({ format: "host.run.settlement", version: 1, runId: run.id,
        outcome: normalizedOutcome, launched: true, settledAt: outcome.finishedAt, result: hostResult, containers: [] });
    } else if (!hostSettlement && scheduled?.state === "running") {
      // The Queue supervisor launched, but no result record survived. This is
      // the contract's lost case and cannot be retried from an unknown result.
      hostSettlement = hostRunSettlementSchema.parse({ format: "host.run.settlement", version: 1, runId: run.id,
        outcome: "lost", launched: true, settledAt: outcome.finishedAt, result: null, containers: [] });
      state = "lost";
    }
    const settled = projectQaRunSchema.parse({
      ...current, state, exitCode: outcome.exitCode, durationMs: outcome.durationMs,
      ...(current.checkoutPath ? { checkoutCleanupPending: outcome.checkoutCleanupPending ?? false } : {}),
      outputTail: tailWithTruncationMarker(detail, PROJECT_QA_TAIL_BYTES), finishedAt: outcome.finishedAt, pid: null,
      capacityWait: null, capacityUnavailable,
      steps: outcome.steps, failedStep: outcome.failedStep, interruptedStep: outcome.interruptedStep,
      failuresLog: outcome.failuresLog ?? current.failuresLog ?? "",
      failureIndexes: outcome.failureIndexes ?? current.failureIndexes,
      logWriteErrors: outcome.logWriteErrors ?? current.logWriteErrors ?? [],
      hostSettlement: hostSettlement ?? current.hostSettlement,
      escapedDescendants,
      cancelReason: outcome.cancelReason ?? current.cancelReason,
    });
    const escapedInResult = hostSettlement?.result?.escapedDescendants ?? [];
    const escapedProvenDead = escapedInResult.length > 0
      && escapedInResult.every(descendant => processStartIdentityLiveness(descendant.pid, descendant.startIdentity) === "dead");
    // A moved integration head is recorded, never a failure: the run proves the
    // exact head it ran, and the operator reruns for the new head.
    try {
      const after = await gitText(current.repository.path, "rev-parse", `origin/${current.baseBranch}`).catch(() => null);
      if (after && after !== current.base) settled.outputTail = tailWithTruncationMarker(`${settled.outputTail}\nIntegration head moved from ${current.base} to ${after} during the run.`, PROJECT_QA_TAIL_BYTES);
    } catch { /* Unknown head is operational silence. */ }
    const latestHostRun = this.hostRuns.get(run.id);
    let saved = settled;
    if (latestHostRun && latestHostRun.state !== "settled" && hostSettlement) {
      this.hostRuns.settle(run.id, hostSettlement, { wallMs: outcome.durationMs, cpuMs: hostResult?.cpuMs ?? null,
        cpuCoverage: hostResult ? boundCpuCoverage(hostResult.cpuMs, outcome.cpuCoverage) : undefined }, () => {
        saved = this.store.putQaRun(settled);
      });
    } else saved = this.store.putQaRun(settled);
    if (escapedInResult.length) {
      if (escapedProvenDead) this.hostRuns.markEscapedDescendantsDead(run.id, escapedInResult);
      else this.watchEscapedDescendants(run.id);
    }
    saved = await this.notifySettled(saved);
    this.releaseRunScratch(saved, Boolean(saved.checkoutCleanupPending));
    return saved;
  },

  /**
   * Tell the project's planner (else the Queue planner) and the submitter that the
   * run settled. A notice carries news; a delivery that failed is recorded on the
   * run instead of being swallowed, and nothing about sending changes its state.
   */
  async notifySettled(this: QaSettleContext, saved: ProjectQaRun): Promise<ProjectQaRun> {
    if (!saved.finishedAt || !this.options.notify) return saved;
    const faults: string[] = [];
    let planner: string | null = null;
    try { planner = this.store.projectPlannerRecipient(this.store.projectFor(saved.repository.path, saved.repository.origin)); }
    catch (error) { faults.push(`the project planner recipient could not be read: ${error instanceof Error ? error.message : String(error)}`); }
    const recipients = uniqueProjectQaRecipients([planner ?? undefined, saved.submitterAgentId]);
    const message = projectQaNotice(saved);
    const notify = this.options.notify;
    await Promise.all(recipients.map(agentId => notify(agentId, `project-qa-settled-${saved.id}-${agentId}`, message)
      .catch(error => { faults.push(`the notice to ${agentId} was not delivered: ${error instanceof Error ? error.message : String(error)}`); })));
    if (!faults.length) return saved;
    const current = this.store.qaRun(saved.id) ?? saved;
    return this.store.putQaRun({ ...current,
      outputTail: tailWithTruncationMarker(`${current.outputTail}\nQA settlement notice: ${faults.join('; ')}.`, PROJECT_QA_TAIL_BYTES) });
  },

  /** Apply the supervisor's own result record, or derive it when the result file is gone. */
  async settleFromSupervisor(this: QaSettleContext, run: ProjectQaRun, state: QaSupervisionState | null, hostResult: HostRunResult | null): Promise<ProjectQaRun> {
    const result = state?.result ?? null;
    if (!result && !hostResult) return run;
    if ((run.teardownRetryAttempt ?? 0) > 0) return this.settleTeardownRetry(run, state);
    this.publishCommandLaunchIdentity(run, state, hostResult);
    const { cancelPath } = qaSupervisionPaths(this.qaRepositoryRootPath(run.key), run.id);
    const cancelRequest = readQaCancelRequest(cancelPath, run.id);
    const finalState = result?.state ?? (cancelRequest ? "cancelled" : hostResult?.signal ? "timed_out" : hostResult?.exitCode === 0 ? "passed" : "failed");
    const finishedAt = result?.finishedAt ?? hostResult?.endedAt ?? now();
    const durationMs = result?.durationMs ?? hostResult?.wallMs ?? Math.max(0, Date.parse(finishedAt) - Date.parse(run.startedAt));
    const detail = result?.detail ?? (cancelRequest
      ? `QA cancelled: ${cancelRequest.reason}`
      : hostResult?.signal ? `QA terminated by ${hostResult.signal}.`
        : hostResult?.exitCode === 0 ? "QA passed." : `QA failed with exit ${hostResult?.exitCode}.`);
    const settled = await this.settle(run, {
      state: finalState, exitCode: result?.exitCode ?? hostResult?.exitCode ?? null, durationMs, detail,
      checkoutCleanupPending: result?.checkoutCleanupPending,
      steps: state?.steps ?? run.steps, failedStep: state?.failedStep ?? run.failedStep,
      logWriteErrors: state?.logWriteErrors ?? run.logWriteErrors,
      failuresLog: state?.failuresLog ?? run.failuresLog ?? null,
      failureIndexes: state?.failureIndexes ?? run.failureIndexes,
      finishedAt, interruptedStep: null, hostResult,
      cpuCoverage: qaSupervisionCpuCoverage(run.id, state, hostResult,
        readQaCpuCoverage(qaSupervisionPaths(this.qaRepositoryRootPath(run.key), run.id).cpuCoveragePath)),
      escapedDescendants: hostResult?.escapedDescendants ?? state?.escapedDescendants ?? run.escapedDescendants,
      cancelReason: cancelRequest?.reason ?? state?.cancelReason ?? run.cancelReason,
    });
    this.watchEscapedDescendants(run.id);
    removeQaSupervisionFiles(this.qaRepositoryRootPath(run.key), run.id);
    return settled;
  },

  /** Settle a run whose launch failed before any supervisor step could start. */
  async settleLaunchFailure(this: QaSettleContext, runId: string, error: unknown): Promise<ProjectQaRun | null> {
    const current = this.store.qaRun(runId);
    if (!current || (current.state !== "running" && current.state !== "queued")) return current;
    const scheduled = this.hostRuns.get(runId);
    if (scheduled?.state === "running" && scheduled.launchedAt) {
      // The supervisor may still own a live command. Keep its scheduler
      // reservation and durable plan/state/result files for the next reconcile.
      return current;
    }
    // Hold the QA row first. rejectBeforeLaunch journals a host-run cancelled
    // settlement and fires the terminal handler, which would otherwise race
    // this hold into a cancelled QA state.
    const settled = await this.settle(current, {
      state: "hold", exitCode: null, durationMs: scheduled?.launchedAt ? Math.max(0, Date.now() - Date.parse(scheduled.launchedAt)) : 0,
      detail: `QA checkout or launch failed: ${String(error)}`, steps: current.steps, failedStep: current.failedStep,
      finishedAt: now(), interruptedStep: null, hostResult: null, escapedDescendants: [], cancelReason: current.cancelReason,
    });
    const latestScheduled = this.hostRuns.get(runId);
    if (latestScheduled && (latestScheduled.state === "queued" || latestScheduled.state === "admitted"))
      this.hostRuns.rejectBeforeLaunch(runId, String(error));
    removeQaSupervisionFiles(this.qaRepositoryRootPath(current.key), runId);
    return settled;
  },
};
