import type { Task } from "../../shared/contracts";
import {
  DEFAULT_GLOBAL_LIMIT,
  isDispositionActive,
} from "../../shared/contracts";
import { groupIsUnavailable } from "../../shared/pool";
import { boardDispatchHoldApplies } from "../../shared/board-dispatch-hold";
import {
  capacityLimitFor,
  dispatchBlocked,
  occupiesSlot,
  QUEUED_VISIT_MARGIN,
  queuedReviewOriginReady,
  queuedVisits,
} from "./capacity";
import { taskNeverDispatched } from "../task-decision-rules";
import { usageGateBlocked } from "./usage-gate";
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
 * `Engine.firstWorkerUnbound` read from the task's own fields alone, so the head
 * walk reads no runs. A queued row whose only trace of a dispatch is a released
 * run reads as unbound here; its visit makes the exact check.
 */
const firstWorkerShape = (task: Task) =>
  task.entrypoint !== "review" &&
  task.entrypoint !== "proof" &&
  task.phase === "queued" &&
  task.hostSelection?.basis !== "worker_profile" &&
  !task.profile &&
  taskNeverDispatched(task, []);

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
          });
      // Spec 069 §1: the admitter takes heads from the ordered ready index, with
      // the fair order, and admits as many as the free slots allow. A head that
      // cannot start now (its host or review origin is away, its target host kind
      // is not ready, or it already had its visit) is skipped in the index walk,
      // so it takes no visit and hides nothing behind it. A visit that starts
      // nothing (a gate the walk cannot see) hands its place to the next head, up
      // to a budget of the free slots plus a small margin, so one pass never
      // walks the queue however its visits end.
      const free = Math.max(
        0,
        limit -
          this.store.activeCapacityTasks().filter((task) => occupiesSlot(task))
            .length,
      );
      let budget = free + QUEUED_VISIT_MARGIN;
      while (budget > 0) {
        const occupied = this.store
          .activeCapacityTasks()
          .filter((task) => occupiesSlot(task));
        const candidates = queuedDispatchOrder(
          // Host readings are taken afresh each round: a visit can fail a host.
          this.store.readyQueueHeads(
            limit + 2,
            repoPath,
            dispatchHeld,
            this.startableHead(attempted, failedHosts),
          ),
          occupied,
        );
        const start = queuedVisits(
          candidates,
          occupied,
          this.store.projectDispatchLimitResolver(),
          this.store.papercutDispatchPolicy(),
          () => "none",
          limit,
        ).start.slice(0, budget);
        if (!start.length) break;
        budget -= start.length;
        for (const task of start) attempted.add(task.id);
        const results = await Promise.allSettled(start.map(visit));
        const failed = results.find((result) => result.status === "rejected");
        if (failed) throw (failed as PromiseRejectedResult).reason;
      }
    });
  }
  /**
   * Whether a ready head could start on a host now, read live from host
   * availability and never from a wait stored on the task (Spec 069 §1). A bound
   * task needs its own host, and a review entry its origin host too; an unbound
   * first worker needs its target host kind, else any host whose catalog is read.
   *
   * Every host and target-host reading is taken once per host or repository and
   * memoised, and the first-worker shape is read from the task's own fields, so a
   * skipped head costs an in-memory check and never a store or host read.
   */
  private startableHead(
    attempted: ReadonlySet<string>,
    failedHosts: ReadonlySet<string>,
  ): (task: Task) => boolean {
    const memo = <T>(cache: Map<string, T>, key: string, read: () => T): T => {
      if (!cache.has(key)) cache.set(key, read());
      return cache.get(key)!;
    };
    const hosts = new Map<string, boolean>();
    const catalogs = new Map<string, boolean>();
    const targets = new Map<string, boolean>();
    const hostReady = (id: string | null | undefined) =>
      Boolean(id) &&
      memo(
        hosts,
        id!,
        () =>
          !failedHosts.has(id!) &&
          this.engine.withHost(id!, () =>
            this.engine.resolution.originHostAvailable(id!),
          ),
      );
    return (task) => {
      if (attempted.has(task.id)) return false;
      if (!queuedReviewOriginReady(task, hostReady)) return false;
      if (!firstWorkerShape(task)) return hostReady(task.hostId);
      const hostKey = task.hostId ?? "";
      if (
        memo(targets, `${task.repoPath}\u0000${hostKey}`, () =>
          Boolean(this.engine.targetHostWait(task)),
        )
      )
        return false;
      return (
        memo(catalogs, hostKey, () =>
          this.engine
            .workerHostCatalogs(task)
            .some((host) => !failedHosts.has(host.hostId)),
        ) || hostReady(task.hostId)
      );
    };
  }
  /**
   * Spec 069 §1: a submission adds its row to the ready index and nothing else.
   * It signals the admitter only when the task itself could start now (its host,
   * or its target host kind, is ready) and its own pools have a free slot. Any
   * other submission is admitted by the next freed slot, released prerequisite,
   * returning host or lifted hold. The check reads active work only, never the queue.
   */
  admitSubmitted(task: Task): void {
    if (this.engine.stopped || this.store.getMeta<boolean>("paused")) return;
    if (dispatchBlocked(task) || isDispositionActive(task)) return;
    if (
      (this.store.getMeta<boolean>("dispatchHeld") ?? false) &&
      boardDispatchHoldApplies(task)
    )
      return;
    if (task.dependsOn.length && this.store.dependencyWait(task)) return;
    if (usageGateBlocked(task, this.store.usageLevel())) return;
    if (!this.startableHead(new Set(), new Set())(task)) return;
    if (
      capacityLimitFor(
        task,
        this.store.activeCapacityTasks(),
        this.store.getMeta<number>("globalLimit") ?? DEFAULT_GLOBAL_LIMIT,
        this.store.projectDispatchLimitResolver()(task),
        this.store.papercutDispatchPolicy(),
      )
    )
      return;
    void this.engine.cleanContext(() =>
      this.engine.wakeRepository(task.repoPath),
    );
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
