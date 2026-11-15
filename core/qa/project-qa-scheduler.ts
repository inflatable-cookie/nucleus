/**
 * Task 104: the host-run scheduler envelope for one milestone QA run. It names
 * the run's class, priority, timeout and caller; it attaches a recorded queued
 * row to the live scheduler, mirrors the queue position, and applies a capacity
 * or pre-launch settlement. It never executes a step itself.
 */
import { randomUUID } from "node:crypto";
import { now, type Store } from "../store/store";
import type { ProjectQaRun, ProjectQaStage, HostRunInternalRecord } from "../../shared/contracts";
import { selectorForArgv } from "../host-runs/host-run-scheduler";
import type { HostRunScheduler } from "../host-runs/host-run-scheduler";
import { DEFAULT_PROCESS_TERMINATION_GRACE_MS } from "../../shared/contracts";
import type { QaPipelineOutcome } from "./project-qa-pipeline";
import { DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES, DEFAULT_PROJECT_QA_TIMEOUT_MS } from "./project-qa-defaults";
import { qaLaunchGates } from "./project-qa-gates";
import type { ProjectQaLaunch } from "./project-qa-context";

export interface QaSchedulerContext {
  store: Store;
  hostRuns: HostRunScheduler;
  qaCallerIdentity(key: string, runId: string): string;
  reconcile(key: string, requestedId?: string): Promise<void>;
  startSupervised(launch: ProjectQaLaunch): Promise<ProjectQaRun>;
  settleLaunchFailure(runId: string, error: unknown): Promise<ProjectQaRun | null>;
  settle(run: ProjectQaRun, outcome: QaPipelineOutcome & { interruptedStep: ProjectQaRun["interruptedStep"] }): Promise<ProjectQaRun>;
  submitToHostScheduler(run: ProjectQaRun, launch: ProjectQaLaunch): void;
  handlerFor(run: ProjectQaRun, launch: ProjectQaLaunch): unknown;
  stagesForRun(run: ProjectQaRun): ProjectQaStage[];
  onSchedulerTerminal(id: string, hostRun: HostRunInternalRecord): Promise<void>;
}

export const projectQaScheduler = {
  /** The ordered stages a stored run executes; a row written before #121 is one "qa" stage. */
  stagesForRun(run: ProjectQaRun): ProjectQaStage[] {
    return run.stages ?? [{ name: "qa", argv: run.argv,
      timeoutMs: run.runTimeoutMs ?? DEFAULT_PROJECT_QA_TIMEOUT_MS,
      maxOutputBytes: run.maxOutputBytes ?? DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES }];
  },

  schedulerInput(run: ProjectQaRun, launch: ProjectQaLaunch) {
    return {
      id: run.id, epoch: launch.epoch, caller: launch.caller,
      repository: run.repository, selector: run.selector ?? selectorForArgv(run.argv, "qa"),
      runClass: run.runClass ?? "heavy", classSource: run.classSource ?? "default",
      priority: "milestone" as const, runTimeoutMs: run.runTimeoutMs ?? launch.timeoutMs,
      submittedAt: run.submittedAt ?? run.startedAt,
    };
  },

  handlerFor(this: QaSchedulerContext, run: ProjectQaRun, launch: ProjectQaLaunch) {
    return {
      launch: async () => {
        let current = this.store.qaRun(run.id);
        if (!current || current.state !== "queued") return;
        if (current.queuePosition !== null || current.capacityWait) {
          current = this.store.putQaRun({ ...current, queuePosition: null, capacityWait: null });
        }
        const gate = this.startSupervised(launch)
          .catch(error => this.settleLaunchFailure(run.id, error))
          .finally(() => { qaLaunchGates.delete(run.key); });
        qaLaunchGates.set(run.key, gate);
        await gate;
      },
      terminal: (hostRun: HostRunInternalRecord) => { void this.onSchedulerTerminal(run.id, hostRun); },
      position: (position: number) => {
        const current = this.store.qaRun(run.id);
        if (!current || current.state !== "queued" || current.queuePosition === position) return;
        this.store.putQaRun({ ...current, queuePosition: position, capacityWait: { position, observedAt: now() } });
      },
    };
  },

  submitToHostScheduler(this: QaSchedulerContext, run: ProjectQaRun, launch: ProjectQaLaunch): void {
    this.hostRuns.submit(projectQaScheduler.schedulerInput(run, launch), this.handlerFor(run, launch) as ReturnType<typeof projectQaScheduler.handlerFor>);
  },

  /** Re-attach a queued row the scheduler still holds, or submit it again under its recorded identity. */
  attachQueued(this: QaSchedulerContext, run: ProjectQaRun): void {
    const scheduled = this.hostRuns.get(run.id);
    if (scheduled?.state === "running") {
      const recovered = this.store.putQaRun({ ...run, state: "running", startedAt: scheduled.launchedAt ?? run.startedAt,
        hostRunEpoch: scheduled.epoch, runTimeoutMs: scheduled.runTimeoutMs, queuePosition: null, capacityWait: null });
      void this.reconcile(recovered.key, recovered.id).catch(() => { /* recovery is retried by the next board read */ });
      return;
    }
    const launch: ProjectQaLaunch = {
      key: run.key, origin: run.repository.origin, path: run.repository.path, checkoutPath: run.repository.path,
      baseBranch: run.baseBranch, base: run.base, argv: run.argv, stages: this.stagesForRun(run),
      timeoutMs: run.runTimeoutMs ?? DEFAULT_PROJECT_QA_TIMEOUT_MS,
      runClass: run.runClass ?? "heavy",
      maxOutputBytes: run.maxOutputBytes ?? DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES,
      terminationGraceMs: run.terminationGraceMs ?? DEFAULT_PROCESS_TERMINATION_GRACE_MS,
      id: run.id, caller: this.qaCallerIdentity(run.key, run.id), identityToken: randomUUID(),
      startedAtMs: Date.parse(run.submittedAt ?? run.startedAt), startedAt: run.submittedAt ?? run.startedAt,
      epoch: run.hostRunEpoch ?? this.hostRuns.authority().epoch,
    };
    const handler = this.handlerFor(run, launch) as ReturnType<typeof projectQaScheduler.handlerFor>;
    if (scheduled) this.hostRuns.attach(run.id, handler);
    else this.submitToHostScheduler(run, launch);
  },

  /** Record the scheduler's launch as the run's start, or return null when it never launched. */
  markLaunched(this: QaSchedulerContext, launch: ProjectQaLaunch): ProjectQaLaunch | null {
    const pending = this.hostRuns.get(launch.id);
    if (!pending || pending.state !== "admitted") return null;
    const active = this.hostRuns.markLaunched(launch.id);
    if (active.state !== "running" || !active.launchedAt) return null;
    const startedAt = active.launchedAt!;
    const startedAtMs = Date.parse(startedAt);
    const current = this.store.qaRun(launch.id);
    if (current && current.state === "queued") this.store.putQaRun({ ...current, state: "running", startedAt,
      submittedAt: current.submittedAt ?? current.startedAt, queuePosition: null, capacityWait: null,
      hostRunEpoch: active.epoch, runTimeoutMs: active.runTimeoutMs });
    return { ...launch, timeoutMs: active.runTimeoutMs, epoch: active.epoch, startedAt, startedAtMs };
  },

  /** Apply a settlement the scheduler reached before any supervisor step: capacity hold or pre-launch cancel. */
  async onSchedulerTerminal(this: QaSchedulerContext, id: string, hostRun: HostRunInternalRecord): Promise<void> {
    const current = this.store.qaRun(id);
    if (!current || current.state === "passed" || current.state === "failed" || current.state === "hold" || current.state === "timed_out" || current.state === "cancelled" || current.state === "lost") return;
    const settlement = hostRun.settlement;
    if (settlement?.outcome === "capacity_timeout") {
      await this.settle(current, { state: "hold", exitCode: null, durationMs: 0,
        detail: "QA capacity deadline expired before launch; this is a hold, not a QA failure.",
        steps: current.steps, failedStep: current.failedStep, finishedAt: settlement.settledAt,
        interruptedStep: null, hostResult: null, escapedDescendants: [], cancelReason: null });
    } else if (settlement?.outcome === "cancelled" && !settlement.launched) {
      await this.settle(current, { state: "cancelled", exitCode: null, durationMs: 0,
        detail: `QA cancelled before launch${current.cancelReason ? `: ${current.cancelReason}` : ""}.`,
        steps: current.steps, failedStep: current.failedStep, finishedAt: settlement.settledAt,
        interruptedStep: null, hostResult: null, escapedDescendants: [], cancelReason: current.cancelReason });
    } else if (!settlement && hostRun.state === "settled") {
      await this.settleLaunchFailure(id, new Error("Host scheduler could not launch QA"));
    }
  },
};
