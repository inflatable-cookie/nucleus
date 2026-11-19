/**
 * Task 114: observe a running run this process is not driving. Apply a settled
 * supervision file, re-attach to a supervisor that is still alive (or whose
 * identity cannot currently be read), resume the one gap a roll leaves before
 * the supervisor's first state file, or reconcile the run as lost only once the
 * supervisor is proven dead.
 */
import { findProcessByCommandToken } from "../machine/process-identity";
import { processGroupEmpty } from "../machine/process-group";
import type { Store } from "../store/store";
import { tailWithTruncationMarker } from "../machine/output-retention";
import type { HostRunEscapedDescendant, HostRunResult, ProjectQaRun, ProjectQaStepName } from "../../shared/contracts";
import { classifyHostRun, selectorForArgv, type HostRunScheduler } from "../host-runs/host-run-scheduler";
import type { SupervisorInspection } from "./project-qa-inspection";
import {
  qaSupervisionPaths, readQaSupervision, readQaSupervisionPlan, readHostRunResult,
  type QaSupervisionPlan, type QaSupervisionState,
} from "./project-qa-supervision-files";
import type { QaPipelineOutcome } from "./project-qa-pipeline";
import { qaAttachments, qaLaunchGates, qaRecoveries } from "./project-qa-gates";
import { DEFAULT_PROJECT_QA_TIMEOUT_MS, PROJECT_QA_TAIL_BYTES } from "./project-qa-defaults";
import type { ProjectQaOptions } from "./project-qa-context";

const sleep = (ms: number) => new Promise<void>(resolvePromise => { setTimeout(resolvePromise, ms); });
/** A supervision file is polled at this cadence while the service waits for the supervisor. */
const SUPERVISION_POLL_MS = 500;

export interface QaReconcileContext {
  store: Store;
  hostRuns: HostRunScheduler;
  options: Pick<ProjectQaOptions, "supervisionPollMs">;
  qaCallerIdentity(key: string, runId: string): string;
  qaRepositoryRootPath(key: string): string;
  checkoutForRun(run: ProjectQaRun): string;
  admitCheckout(run: ProjectQaRun): void;
  inspectSupervisor(run: ProjectQaRun): Promise<SupervisorInspection>;
  attachQueued(run: ProjectQaRun): void;
  spawnQaSupervisor(planPath: string, identityToken: string, temporaryDirectory?: string): number;
  watchEscapedDescendants(runId: string): void;
  settle(run: ProjectQaRun, outcome: QaPipelineOutcome & { interruptedStep: ProjectQaStepName | null }): Promise<ProjectQaRun>;
  settleFromSupervisor(run: ProjectQaRun, state: QaSupervisionState | null, hostResult: HostRunResult | null, closeInterrupted?: boolean): Promise<ProjectQaRun>;
  /** #1393: settle a run whose step's group ended and whose supervisor never settled. */
  settleEndedStep(run: ProjectQaRun, inspection: Extract<SupervisorInspection, { kind: "step_ended" }>): Promise<void>;
  reconcileLostRun(run: ProjectQaRun, state: QaSupervisionState | null, reason: string, escapedDescendants?: HostRunEscapedDescendant[]): Promise<void>;
  noteCheckoutWait(run: ProjectQaRun, error: unknown): void;
  watchSupervisor(runId: string, key: string, unstartedResumes?: number): Promise<void>;
  resumeUnstartedSupervisor(run: ProjectQaRun, plan: QaSupervisionPlan): Promise<void>;
  attachSupervisor(runId: string, key: string, unstartedResumes?: number): Promise<ProjectQaRun>;
  mirrorSupervisorProgress(run: ProjectQaRun, state: QaSupervisionState): void;
  publishCommandLaunchIdentity(run: ProjectQaRun, state: QaSupervisionState | null, hostResult: HostRunResult | null): void;
}

export const projectQaReconcile = {
  async reconcile(this: QaReconcileContext, key: string, requestedId?: string): Promise<void> {
    const latest = requestedId ? this.store.qaRun(requestedId) : this.store.latestQaRun(key);
    if (!latest || latest.key !== key) return;
    if (latest.state === "queued") { this.attachQueued(latest); return; }
    if (latest.state !== "running") return;
    if (!this.hostRuns.get(latest.id)) {
      const selector = latest.selector ?? selectorForArgv(latest.argv, "qa");
      const classification = latest.runClass ? { runClass: latest.runClass, classSource: latest.classSource ?? "default" as const }
      : classifyHostRun(latest.repository.path, selector, selector === "test" && latest.argv.length > 2);
      this.hostRuns.adoptRunning({ id: latest.id, epoch: this.hostRuns.authority().epoch,
        caller: this.qaCallerIdentity(latest.key, latest.id), repository: latest.repository,
        selector, ...classification, priority: "milestone", runTimeoutMs: latest.runTimeoutMs ?? DEFAULT_PROJECT_QA_TIMEOUT_MS,
        submittedAt: latest.submittedAt ?? latest.startedAt, launchedAt: latest.startedAt, pid: latest.pid });
    }
    const alreadyWatching = qaAttachments.has(latest.id);
    const inspection = await this.inspectSupervisor(latest);
    if (JSON.stringify(this.store.qaRun(latest.id)) !== JSON.stringify(latest)) return;
    if (alreadyWatching) {
      if (inspection.kind !== "dead" && inspection.kind !== "step_ended") return;
      const activeRecovery = qaRecoveries.get(key);
      if (activeRecovery) return activeRecovery as Promise<void>;
      const settling = (inspection.kind === "step_ended"
        ? this.settleEndedStep(latest, inspection)
        : this.reconcileLostRun(latest, inspection.state, inspection.reason, inspection.escapedDescendants))
        .finally(() => qaRecoveries.delete(key));
      qaRecoveries.set(key, settling);
      return settling;
    }
    const activeRecovery = qaRecoveries.get(key);
    if (activeRecovery) return activeRecovery as Promise<void>;
    if (inspection.kind === "settled") {
      const settling = this.settleFromSupervisor(latest, inspection.state, inspection.hostResult, inspection.closeInterrupted)
        .then(() => {}).finally(() => qaRecoveries.delete(key));
      qaRecoveries.set(key, settling);
      return settling;
    }
    // #1393: a step whose group ended and a supervisor that never settled is a
    // run with a known cause, not an unexplained loss. It is settled from the
    // step's own evidence instead of waiting for the capacity deadline.
    if (inspection.kind === "step_ended") {
      const recovery = qaRecoveries.get(key);
      if (recovery) return recovery as Promise<void>;
      const settling = this.settleEndedStep(latest, inspection).finally(() => qaRecoveries.delete(key));
      qaRecoveries.set(key, settling);
      return settling;
    }
    if (inspection.kind === "running") {
      // A supervisor still owns this run: wait for it in the background instead
      // of reaping it, so a board read never blocks on a long QA command.
      const watching = this.watchSupervisor(latest.id, key).finally(() => { qaAttachments.delete(latest.id); });
      qaAttachments.set(latest.id, watching);
      void watching.catch(() => { /* the watcher records its own fault on the run */ });
      return;
    }
    if (inspection.kind === "unstarted") {
      // The host scheduler records launch immediately before Queue spawns the
      // detached supervisor. Its first supervision state is written before
      // checkout preparation or any QA command, so this gap is safe to resume
      // with the same plan and run ID after a backend restart.
      if (qaLaunchGates.has(key)) return;
      const recovery = qaRecoveries.get(key);
      if (recovery) return recovery as Promise<void>;
      const resumed = this.resumeUnstartedSupervisor(latest, inspection.plan)
        .catch((error: unknown) => { if (!latest.checkoutPath) throw error; this.noteCheckoutWait(latest, error); })
        .finally(() => qaRecoveries.delete(key));
      qaRecoveries.set(key, resumed);
      void resumed.catch(() => { /* startup recovery is retried by the next board read */ });
      return;
    }
    if (qaLaunchGates.has(key)) return;
    const recovery = qaRecoveries.get(key);
    if (recovery) return recovery as Promise<void>;
    const lost = this.reconcileLostRun(latest, inspection.state, inspection.reason, inspection.escapedDescendants)
      .catch((error: unknown) => { if (!latest.checkoutPath) throw error; this.noteCheckoutWait(latest, error); }).finally(() => qaRecoveries.delete(key));
    qaRecoveries.set(key, lost);
    return lost;
  },

  /** Resume the existing admission when the detached supervisor never began the pipeline. */
  async resumeUnstartedSupervisor(this: QaReconcileContext, run: ProjectQaRun, plan: QaSupervisionPlan): Promise<void> {
    if (plan.checkoutPath !== this.checkoutForRun(run) || Boolean(plan.externalCheckout) !== Boolean(run.checkoutPath))
      throw Error("Project QA supervision plan checkout identity changed");
    const current = this.store.qaRun(run.id);
    if (!current || current.state !== "running") return;
    const { statePath, planPath, resultPath } = qaSupervisionPaths(this.qaRepositoryRootPath(run.key), run.id);
    const persistedPlan = readQaSupervisionPlan(planPath);
    if (!persistedPlan || persistedPlan.runId !== run.id || persistedPlan.key !== run.key
        || persistedPlan.identityToken !== plan.identityToken) return;
    // Another launch may have become visible since inspection. Any state,
    // result or identity-bearing process belongs to the existing supervisor;
    // attach to it instead of spawning a duplicate.
    const process = findProcessByCommandToken(plan.identityToken);
    if (readQaSupervision(statePath) || readHostRunResult(resultPath, run.id) || process.state !== "absent") {
      await this.attachSupervisor(run.id, run.key);
      return;
    }
    const scheduledGroup = this.hostRuns.get(run.id)?.processGroupId;
    if (scheduledGroup && !processGroupEmpty(scheduledGroup)) {
      await this.attachSupervisor(run.id, run.key);
      return;
    }
    this.admitCheckout(run);
    const pid = this.spawnQaSupervisor(planPath, plan.identityToken, plan.temporaryDirectory);
    const latest = this.store.qaRun(run.id);
    if (latest?.state === "running") this.store.putQaRun({ ...latest, pid });
    await this.attachSupervisor(run.id, run.key, 1);
  },

  /** Attach to a live supervisor and wait for it to settle; concurrent callers share one watcher. */
  async attachSupervisor(this: QaReconcileContext, runId: string, key: string, unstartedResumes = 0): Promise<ProjectQaRun> {
    const existing = qaAttachments.get(runId);
    if (existing) { await existing; return this.store.qaRun(runId)!; }
    const watching = this.watchSupervisor(runId, key, unstartedResumes).finally(() => { qaAttachments.delete(runId); });
    qaAttachments.set(runId, watching);
    await watching;
    return this.store.qaRun(runId)!;
  },

  /**
   * Poll one run's supervision file: mirror recorded steps onto the record as
   * they settle, settle the record when the supervisor writes its result, and
   * reconcile as lost the moment the supervisor is proven dead.
   */
  async watchSupervisor(this: QaReconcileContext, runId: string, key: string, unstartedResumes = 0): Promise<void> {
    const pollMs = this.options.supervisionPollMs ?? SUPERVISION_POLL_MS;
    for (;;) {
      const current = this.store.qaRun(runId);
      if (!current || current.state !== "running") return;
      const inspection = await this.inspectSupervisor(current);
      if (JSON.stringify(this.store.qaRun(runId)) !== JSON.stringify(current)) continue;
      this.publishCommandLaunchIdentity(current, inspection.state,
        inspection.kind === "settled" ? inspection.hostResult : null);
      if (inspection.kind === "settled") { await this.settleFromSupervisor(current, inspection.state, inspection.hostResult, inspection.closeInterrupted); return; }
      if (inspection.kind === "step_ended") {
        const recovery = qaRecoveries.get(key);
        if (recovery) { await recovery; return; }
        const settling = this.settleEndedStep(current, inspection).finally(() => qaRecoveries.delete(key));
        qaRecoveries.set(key, settling);
        await settling;
        return;
      }
      if (inspection.kind === "dead") {
        const recovery = qaRecoveries.get(key);
        if (recovery) { await recovery; return; }
        const settling = this.reconcileLostRun(current, inspection.state, inspection.reason, inspection.escapedDescendants)
          .finally(() => qaRecoveries.delete(key));
        qaRecoveries.set(key, settling);
        await settling;
        return;
      }
      if (inspection.kind === "unstarted") {
        if (unstartedResumes >= 1) {
          await this.reconcileLostRun(current, null, "the supervisor exited before publishing its initial state");
          return;
        }
        // This watcher may itself be the first post-restart observer. One
        // bounded resume handles an initially unreadable process scan; if the
        // new supervisor also exits before publishing state, settle normally.
        const { planPath } = qaSupervisionPaths(this.qaRepositoryRootPath(current.key), current.id);
        const plan = readQaSupervisionPlan(planPath);
        if (!plan || plan.runId !== current.id || plan.key !== current.key) {
          await this.reconcileLostRun(current, null, "the detached supervisor plan is unavailable");
          return;
        }
        const pid = this.spawnQaSupervisor(planPath, plan.identityToken, plan.temporaryDirectory);
        const latest = this.store.qaRun(runId);
        if (latest?.state === "running") this.store.putQaRun({ ...latest, pid });
        unstartedResumes++;
        continue;
      }
      if (inspection.state && (inspection.state.steps.length !== current.steps.length
          || JSON.stringify(inspection.state.logWriteErrors) !== JSON.stringify(current.logWriteErrors))) {
        // #136: a failed progress mirror must not stop supervision. The run keeps
        // its reservation and identity; the next poll retries the mirror.
        try { this.mirrorSupervisorProgress(current, inspection.state); }
        catch { /* a transient store write failure is retried on the next poll */ }
      }
      await sleep(pollMs);
    }
  },

  /** Show a running supervisor's settled steps on the record before the run finishes. */
  mirrorSupervisorProgress(this: QaReconcileContext, run: ProjectQaRun, state: QaSupervisionState): void {
    const current = this.store.qaRun(run.id);
    if (!current || current.state !== "running") return;
    this.store.putQaRun({ ...current, steps: state.steps, failedStep: state.failedStep,
      logWriteErrors: state.logWriteErrors,
      escapedDescendants: state.escapedDescendants, cancelReason: state.cancelReason });
  },

  /** Publish the command identity independently of whether a step has settled. */
  publishCommandLaunchIdentity(this: QaReconcileContext, run: ProjectQaRun, state: QaSupervisionState | null, hostResult: HostRunResult | null): void {
    const active = state?.activeProcess;
    const identity = active ? { pid: active.pid, processGroupId: active.processGroupId, startIdentity: active.startIdentity }
      : hostResult ? { pid: hostResult.pgid, processGroupId: hostResult.pgid, startIdentity: hostResult.startIdentity } : null;
    if (!identity) return;
    const current = this.hostRuns.get(run.id);
    if (!current || current.state !== "running"
        || current.pid === identity.pid && current.processGroupId === identity.processGroupId && current.startIdentity === identity.startIdentity) return;
    try { this.hostRuns.updateProcess(run.id, identity); }
    catch { /* A settled scheduler row no longer accepts process updates. */ }
  },

  /** A checkout that is not yet reconcilable says so on the run; it is not a lost run. */
  noteCheckoutWait(this: { store: Store }, run: ProjectQaRun, error: unknown): void {
    const current = this.store.qaRun(run.id);
    if (!current || current.state !== "running") return;
    const detail = `QA checkout reconciliation waiting: ${error instanceof Error ? error.message : String(error)}`;
    if (!current.outputTail.includes(detail)) this.store.putQaRun({ ...current,
      outputTail: tailWithTruncationMarker(`${current.outputTail}${current.outputTail ? "\n" : ""}${detail}`, PROJECT_QA_TAIL_BYTES) });
  },
};
