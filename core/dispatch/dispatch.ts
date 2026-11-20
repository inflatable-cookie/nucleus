import type { Task } from "../../shared/contracts";
import {
  DEFAULT_GLOBAL_LIMIT,
  isDispositionActive,
} from "../../shared/contracts";
import { groupIsUnavailable } from "../../shared/pool";
import { occupiesSlot, queuedVisits } from "./capacity";
import {
  PRE_DISPATCH_BASE_ADVANCE_LIMIT,
  queuedDispatchOrder,
  type Engine,
} from "../engine";
import {
  hookHoldReason,
  READ_ONLY_BASE_ADVANCED_KIND,
  type HookEmissionResult,
} from "../hooks/hooks";
import { LANE_PRIORITY_TASK } from "../scheduling/lane-priorities";
import { FirstDispatch } from "./first-dispatch";
import { ReviewEntryAdmission } from "./review-entry-admission";
import { ProofOnlyLaunch } from "./proof-only-launch";
import { WorkspacePressure } from "./workspace-pressure";
import {
  HostTransportFault,
  hostFaultHost,
  recordHostFailure,
} from "../host/adapter-routing";

export {
  dispatchGate,
  decideWorkspacePressureWait,
} from "./dispatch-decisions";

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
      wake: () =>
        void engine.cleanContext(() => engine.dispatchQueued()).catch(() => {}),
    });
    this.reviewEntryAdmission = new ReviewEntryAdmission(engine);
    // FirstDispatch owns ordinary task errors. Let a typed host failure
    // escape its catch so the dispatch pass can hold that host and try other heads.
    const firstContext = new Proxy(engine, {
      get(target, property, receiver) {
        if (property === "noteStepFailure")
          return (taskId: string, error: unknown) => {
            if (error instanceof HostTransportFault) throw error;
            return target.noteStepFailure(taskId, error);
          };
        return Reflect.get(target, property, receiver);
      },
    });
    this.first = new FirstDispatch(firstContext, {
      reviewEntryAdmission: (task) => this.reviewEntryAdmission.admit(task),
    });
    this.proofOnly = new ProofOnlyLaunch(engine);
  }
  stop() {
    this.pressure.stop();
  }
  get store() {
    return this.engine.store;
  }
  get adapter() {
    return this.engine.adapter;
  }
  get resolution() {
    return this.engine.resolution;
  }
  notePreDispatchHold(id: string, emission: HookEmissionResult) {
    const current = this.store.task(id);
    if (
      current.removedAt ||
      current.phase !== "queued" ||
      isDispositionActive(current)
    )
      return;
    // A gate superseded because main fast-forwarded under it answered nothing: stay
    // queued so the next pass mints a fresh gate at the new base. Bounded, so a base
    // that never holds still reaches a human.
    const advanced = emission.records.find(
      (record) => record.event === "task.pre_dispatch" && record.baseAdvance,
    );
    if (
      advanced &&
      this.store
        .events(id)
        .filter((event) => event.kind === READ_ONLY_BASE_ADVANCED_KIND)
        .length <= PRE_DISPATCH_BASE_ADVANCE_LIMIT
    ) {
      this.engine.note(
        id,
        "Integration base advanced during the pre-dispatch gate; re-running it at the new base",
        "lifecycle",
      );
      return;
    }
    this.engine.note(
      id,
      hookHoldReason(emission),
      "operator_needed",
      "needs_attention",
    );
  }
  async dispatchQueued(repoPath?: string): Promise<void> {
    const dispatchHeld = this.store.getMeta<boolean>("dispatchHeld") ?? false;
    const availability = this.store.availability();
    this.store.setRoutingEpoch(
      JSON.stringify([
        this.engine.profiles,
        this.engine
          .hostIds()
          .map((id) => [
            id,
            this.engine.withHost(id, () => this.engine.hostAvailable(id)),
            this.engine.profilesFor(id),
          ]),
        this.store.pool(),
        availability.map((group) => [group.group, groupIsUnavailable(group)]),
        this.store.usageLevel(),
      ]),
    );
    const limit =
      this.store.getMeta<number>("globalLimit") ?? DEFAULT_GLOBAL_LIMIT;
    await this.resolution.withDispatchPass(async () => {
      const attempted = new Set<string>();
      const failedHosts = new Set<string>();
      const failedTasks = new Set<string>();
      const visit = (candidate: Task) =>
        this.engine
          .scheduleLane(`task:${candidate.id}`, LANE_PRIORITY_TASK, () =>
            this.engine.dispatchTask(candidate.id, dispatchHeld),
          )
          .catch((error) => {
            const hostId = hostFaultHost(error);
            if (!hostId) throw error;
            failedHosts.add(hostId);
            recordHostFailure(this.adapter, hostId, error);
          })
          .then(() => {
            // FirstDispatch can record the transport wait itself before returning.
            const task = this.store.task(candidate.id);
            if (
              task.hostId &&
              (task.resolution.hostWait ||
                task.resolution.stop?.reason === "host_unavailable")
            ) {
              failedHosts.add(task.hostId);
            }
            if (task.phase === "needs_attention") failedTasks.add(task.id);
            if (task.resolution.stop?.reason === "origin_busy")
              failedTasks.add(task.id);
            // nucleus#1416: an unbound task waiting on its target host kind
            // (repository, then operator default) is a settled visit, not
            // progress. Counting it lets the pass reach healthy projects behind
            // it instead of stopping on "nothing moved".
            if (
              task.phase === "queued" &&
              this.engine.firstWorkerUnbound(task) &&
              this.engine.targetHostWait(task)
            )
              failedTasks.add(task.id);
          });
      for (;;) {
        const skipped = failedHosts.size
          ? this.store
              .tasks()
              .filter((task) => task.hostId && failedHosts.has(task.hostId))
              .length
          : 0;
        const occupied = this.store
          .activeCapacityTasks()
          .filter((task) => occupiesSlot(task));
        const candidates = queuedDispatchOrder(
          this.store.readyQueueHeads(
            limit + 2 + skipped + failedTasks.size,
            repoPath,
            dispatchHeld,
          ),
          occupied,
        ).filter(
          (task) =>
            !attempted.has(task.id) &&
            (this.engine.firstWorkerUnbound(task) ||
              !task.hostId ||
              !failedHosts.has(task.hostId)),
        );
        const { start } = queuedVisits(
          candidates,
          occupied,
          this.store.projectDispatchLimitResolver(),
          this.store.papercutDispatchPolicy(),
          () => "none",
          limit,
        );
        if (!start.length) break;
        for (const task of start) attempted.add(task.id);
        const before = failedHosts.size + failedTasks.size;
        const results = await Promise.allSettled(start.map(visit));
        const failed = results.find((result) => result.status === "rejected");
        if (failed) throw (failed as PromiseRejectedResult).reason;
        if (failedHosts.size + failedTasks.size === before) {
          const stillQueued = start.filter(
            (task) => this.store.task(task.id).phase === "queued",
          ).length;
          if (stillQueued === 0 || stillQueued === start.length) break;
        }
      }
    });
  }
  workspacePressureWait(task: Task, host = this.adapter.hostLoad?.()): string {
    return this.pressure.wait(task, host);
  }
  armWorkspacePressureWake(): void {
    this.pressure.arm();
  }
  /** Dispatch shares ownership with task controls and hook reconciliation. */
  async dispatchTask(taskId: string, dispatchHeld: boolean): Promise<void> {
    try {
      await this.first.dispatch(taskId, dispatchHeld);
    } catch (error) {
      if (!(error instanceof HostTransportFault)) throw error;
      recordHostFailure(this.adapter, error.hostId, error);
      const task = this.store.task(taskId);
      if (task.hostId !== error.hostId && task.originHostId === error.hostId)
        this.engine.note(
          taskId,
          `Waiting for origin host ${error.hostId}: ${error.message}`,
          "origin_busy",
        );
      return;
    }
    const task = this.store.task(taskId);
    if (
      task.hostId &&
      (task.resolution.hostWait ||
        task.resolution.stop?.reason === "host_unavailable")
    )
      recordHostFailure(this.adapter, task.hostId, undefined);
  }
  /** Proof-only dispatch always enters its executor/release-GO route, never the worker launcher. */
  launchProofOnly(
    task: Task,
    selectedProfile?: Parameters<ProofOnlyLaunch["launch"]>[1],
  ): Promise<void> {
    return this.proofOnly.launch(task, selectedProfile);
  }
  dispatchReviewEntry(task: Task): Promise<void> {
    return this.reviewEntryAdmission.admit(task);
  }
  performReviewEntryAdmission(task: Task): Promise<void> {
    return this.reviewEntryAdmission.admit(task);
  }
}
