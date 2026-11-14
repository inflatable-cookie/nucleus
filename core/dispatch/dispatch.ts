import type { Task } from "../../shared/contracts";
import { DEFAULT_GLOBAL_LIMIT, isDispositionActive } from "../../shared/contracts";
import { unavailableGroups } from '../../shared/pool';
import { groupIsUnavailable } from '../../shared/pool';
import { occupiesSlot, queuedVisits } from "./capacity";
import { PRE_DISPATCH_BASE_ADVANCE_LIMIT, queuedDispatchOrder, type Engine } from "../engine";
import { hookHoldReason, READ_ONLY_BASE_ADVANCED_KIND, type HookEmissionResult } from "../hooks/hooks";
import { LANE_PRIORITY_TASK } from "../scheduling/lane-priorities";
import { FirstDispatch } from './first-dispatch';
import { ReviewEntryAdmission } from './review-entry-admission';
import { ProofOnlyLaunch } from './proof-only-launch';
import { WorkspacePressure } from './workspace-pressure';

export { dispatchGate, decideWorkspacePressureWait } from './dispatch-decisions';

/**
 * The dispatch pass: read the queued order once, start the free slots together
 * on their own task lanes, and hand each task to the first-dispatch owner. It
 * also owns the bounded workspace-pressure wake and the pre-dispatch hold
 * record. First dispatch, review-entry admission and proof-only launch are
 * separate owners, so a pass never contains another dispatch's rules.
 */
export class Dispatch {
  private readonly pressure: WorkspacePressure;
  private readonly first: FirstDispatch;
  private readonly reviewEntryAdmission: ReviewEntryAdmission;
  private readonly proofOnly: ProofOnlyLaunch;
  constructor(readonly engine: Engine) {
    this.pressure = new WorkspacePressure({
      store: engine.store,
      stopped: () => engine.stopped,
      wake: () => void engine.cleanContext(() => engine.dispatchQueued()).catch(() => {}),
    });
    this.reviewEntryAdmission = new ReviewEntryAdmission(engine);
    this.first = new FirstDispatch(engine, { reviewEntryAdmission: task => this.reviewEntryAdmission.admit(task) });
    this.proofOnly = new ProofOnlyLaunch(engine);
  }
  stop() { this.pressure.stop(); }
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get resolution() { return this.engine.resolution; }
  notePreDispatchHold(id: string, emission: HookEmissionResult) {
    const current = this.store.task(id);
    if (current.removedAt || current.phase !== "queued" || isDispositionActive(current)) return;
    // A gate superseded because main fast-forwarded under it answered nothing: stay
    // queued so the next pass mints a fresh gate at the new base. Bounded, so a base
    // that never holds still reaches a human.
    const advanced = emission.records.find(record => record.event === "task.pre_dispatch" && record.baseAdvance);
    if (advanced && this.store.events(id).filter(event => event.kind === READ_ONLY_BASE_ADVANCED_KIND).length <= PRE_DISPATCH_BASE_ADVANCE_LIMIT) {
      this.engine.note(id, "Integration base advanced during the pre-dispatch gate; re-running it at the new base", 'lifecycle');
      return;
    }
    this.engine.note(id, hookHoldReason(emission), 'operator_needed', "needs_attention");
  }
  async dispatchQueued(repoPath?: string): Promise<void> {
    const dispatchHeld = this.store.getMeta<boolean>("dispatchHeld") ?? false;
    const availability = this.store.availability();
    this.store.setRoutingEpoch(JSON.stringify([this.engine.profiles, this.store.pool(),
      availability.map(group => [group.group, groupIsUnavailable(group)]),
      this.store.usageLevel(), this.store.demandRoleOffsets()]));
    const limit = this.store.getMeta<number>("globalLimit") ?? DEFAULT_GLOBAL_LIMIT;
    const candidates = queuedDispatchOrder(this.store.readyQueueHeads(limit + 2, repoPath, dispatchHeld));
    await this.resolution.withDispatchPass(async () => {
      const visit = (candidate: Task) => this.engine.scheduleLane(`task:${candidate.id}`, LANE_PRIORITY_TASK, () => this.engine.dispatchTask(candidate.id, dispatchHeld));
      const { start, rest } = queuedVisits(candidates, this.store.activeCapacityTasks().filter(task => occupiesSlot(task)),
        this.store.projectDispatchLimitResolver(), this.store.papercutDispatchPolicy(), () => "none", limit);
      // Free slots start together, so one slow or stuck workspace doesn't hold up the next.
      // Each task has its own lane and the intent transaction re-checks capacity and the gap.
      const results = await Promise.allSettled(start.map(visit));
      const failed = results.find(result => result.status === "rejected");
      if (failed) throw (failed as PromiseRejectedResult).reason;
      // Waiting for a slot is derived on read, not a reason to visit a task.
      void rest;
    });
  }
  workspacePressureWait(task: Task, host = this.adapter.hostLoad?.()): string {
    return this.pressure.wait(task, host);
  }
  armWorkspacePressureWake(): void { this.pressure.arm(); }
  /** Dispatch shares ownership with task controls and hook reconciliation. */
  dispatchTask(taskId: string, dispatchHeld: boolean): Promise<void> { return this.first.dispatch(taskId, dispatchHeld); }
  /** Proof-only dispatch always enters its executor/release-GO route, never the worker launcher. */
  launchProofOnly(task: Task, selectedProfile?: Parameters<ProofOnlyLaunch['launch']>[1]): Promise<void> { return this.proofOnly.launch(task, selectedProfile); }
  dispatchReviewEntry(task: Task): Promise<void> { return this.reviewEntryAdmission.admit(task); }
  performReviewEntryAdmission(task: Task): Promise<void> { return this.reviewEntryAdmission.admit(task); }
}
