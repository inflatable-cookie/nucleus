import type { Resolution } from "../resolution";
import type { Engine } from "../engine";
import { STOPPED_BEFORE_DRAIN } from "../engine";
import { enginePorts } from "../port-context";
import type { Task } from "../../shared/contracts";
import { isDispositionActive } from "../../shared/contracts";
import type { ReconciliationSweep } from "../../shared/telemetry";
import type { AgentObservation } from "../host/adapter";
import { catchUpFinishedTaskThreads } from "../workspaces/thread-archive";
import { resumeDispositions } from "../verbs/disposition";
import { completionReportsPr } from "../recovery/worker-reconcile";
import { LANE_PRIORITY_AUDIT, LANE_PRIORITY_TASK } from "./lane-priorities";
import { TASK_QUANTUM_BOUND_MS, boundQuantum } from "./quantum-bound";
import { startsNoRuns } from "../closeout/queue-drain";
import { now } from "../store/store";
import { HostPass } from "./host-pass";
import { SweepMaintenance } from "./sweep-maintenance";
import {
  HostTransportFault,
  hostFaultHost,
  recordHostFailure,
} from "../host/adapter-routing";
import { archiveRetiredErroredAgents } from "../workspaces/retired-agent-archive";

/**
 * Tasks reconciled per bounded safety-sweep window (Spec 013). The minute sweep
 * advances one page and yields; it never walks the fleet in a single pass. An
 * explicit reconciliation drains pages until the durable cursor wraps once.
 */
const SWEEP_WINDOW = 25;
/** Upper bound on pages drained by one explicit reconciliation request. */
const MAX_SWEEP_WINDOWS = 400;
type DrainWaiter = { resolve: () => void; reject: (error: Error) => void };

export type SweepContext = Pick<
  Engine,
  | "adapter"
  | "applyDeferredOwnerVerbs"
  | "deliverPendingBriefAmendments"
  | "archivePlannerGrants"
  | "archiveRetiredErroredAgents"
  | "auditPass"
  | "clearRetiredInvalidations"
  | "continueAwaitingReviewers"
  | "dispatchQueued"
  | "dispositionDeps"
  | "drainProjections"
  | "drainWaiters"
  | "enqueueTitle"
  | "ensureSweep"
  | "flushPrerequisiteReleases"
  | "host"
  | "hostAvailable"
  | "hostIds"
  | "hostOutages"
  | "hostWait"
  | "inventoryHostMatches"
  | "lifecycle"
  | "markAuditHostUnavailable"
  | "maxSweepWindows"
  | "migrateProjectOwnersToPlanners"
  | "noteStepFailure"
  | "observeRetiredWorkers"
  | "quiesce"
  | "reconcile"
  | "recoverExhaustedWorkers"
  | "removeSiblings"
  | "resetAuditHostAvailability"
  | "resumePausedStops"
  | "retiredObservationKey"
  | "retiredObservationPlan"
  | "scheduleLane"
  | "scheduleLifecycleFollowUp"
  | "scheduleTaskQuantum"
  | "settleQuiesce"
  | "startSweepChain"
  | "stopped"
  | "store"
  | "sweepChain"
  | "sweepCursor"
  | "sweepMode"
  | "sweepOrder"
  | "sweepPending"
  | "sweepStats"
  | "taskHostAvailable"
  | "wakeCapacityWaiter"
  | "wakePreludes"
  | "withHost"
> & {
  readonly resolution: Pick<
    Resolution,
    | "checkpoints"
    | "delegateNativeQuestions"
    | "deliverDecisionNotices"
    | "deliverDrainNotices"
    | "deliverHoldNotices"
    | "deliverHostOutageNotices"
    | "deliverNotices"
    | "deliverQueuedMessages"
    | "observationTargets"
    | "observe"
    | "origins"
    | "raiseOperatorQuestions"
    | "recovery"
    | "resumeAskQuestions"
    | "resumeResponsibleAnsweredQuestions"
    | "refreshResponsibleThreads"
    | "settleBudgetClock"
  >;
};

export class Sweep {
  private hostPassOwner: HostPass | null = null;
  private maintenanceOwner: SweepMaintenance | null = null;
  /** The one owner of one host's audit steps: settlement, presentation and observation reads. */
  get hostPass(): HostPass {
    return (this.hostPassOwner ??= new HostPass(
      enginePorts(
        this.engine,
        [
          "adapter",
          "host",
          "inventoryHostMatches",
          "observeRetiredWorkers",
          "retiredObservationKey",
          "retiredObservationPlan",
          "scheduleLane",
          "stopped",
          "store",
        ],
        ["observationTargets"],
      ),
    ));
  }
  /** The periodic store and engine chores, on their own cadence. */
  get maintenance(): SweepMaintenance {
    return (this.maintenanceOwner ??= new SweepMaintenance(
      enginePorts(
        this.engine,
        [
          "adapter",
          "hostAvailable",
          "hostIds",
          "migrateProjectOwnersToPlanners",
          "removeSiblings",
          "stopped",
          "store",
          "withHost",
        ],
        [],
      ),
    ));
  }
  /** The hourly hook and data-home retention pass belongs to `maintenance`, not the sweep. */
  get lastHookCleanupAt(): number {
    return this.maintenance.lastHookCleanupAt;
  }
  set lastHookCleanupAt(value: number) {
    this.maintenance.lastHookCleanupAt = value;
  }

  /**
   * A task quantum that outlived its bound is that task's observation outage: the
   * sweep moved on, the task's lane stays held by the running quantum, and the
   * next sweep queues behind it. Recorded as a task event, not a phase change.
   */
  recordQuantumOutage(taskId: string): void {
    this.engine.store.event(
      taskId,
      "observation_outage",
      `Task quantum did not return within ${TASK_QUANTUM_BOUND_MS / 1000} s; the sweep moved on and this task's lane stays held until it returns`,
    );
  }
  /** Durable cursor for the bounded safety sweep: the last task identity reconciled. */
  sweepCursor: string | null = null;
  sweepChain: Promise<void> | null = null;
  sweepMode: "window" | "drain" | null = null;
  sweepPending: "window" | "drain" | null = null;
  /**
   * Drain requests not yet covered. Each is settled by the first full drain
   * pass that STARTED after it, never by the whole chain: safety-tick windows
   * may keep extending the chain indefinitely (a pass longer than the tick
   * re-queues one behind itself), and a drain caller must not wait on them.
   */
  drainWaiters: DrainWaiter[] = [];
  /** Windows one audit pass may run; a drain past it continues in the next pass. Replaceable only by tests. */
  maxSweepWindows = MAX_SWEEP_WINDOWS;
  readonly sweepStats = {
    windows: 0,
    swept: 0,
    tasks: 0,
    lastPassAt: null as string | null,
  };
  constructor(readonly engine: SweepContext) {}
  /** A failed host step is an outage for that host, never an engine fault. */
  private async fleetStep(
    name: string,
    work: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      const hostId = hostFaultHost(error);
      if (!hostId) throw error;
      const fault =
        error instanceof HostTransportFault
          ? error
          : new HostTransportFault(hostId, error);
      recordHostFailure(this.engine.adapter, hostId, fault);
      this.engine.store.setMeta(
        "hostPassError",
        `${hostId}/${name}: ${fault.message}`.slice(0, 2000),
      );
    }
  }
  sweepOnce(): Promise<void> {
    if (this.engine.stopped) return Promise.resolve();
    void this.engine.flushPrerequisiteReleases().catch(() => {});
    return this.engine.ensureSweep("window");
  }

  wake(): Promise<void> {
    if (this.engine.stopped) return Promise.resolve();
    // The bounded drain cut: the drain this call requested has covered the
    // fleet, the lane work it scheduled has settled, and the titles have
    // drained. Window passes the safety tick queues after it are not awaited.
    // Cleanup is kicked but not awaited: a workspace archive legitimately runs
    // for minutes, and the board's reconciliation diagnostic must not wait on
    // one (Tom, 2026-11-05).
    // The prelude yields before the drain has a lane, and a callback's fire-and-forget
    // wake is accepted work: quiesce() must not answer in that gap (nucleus #752).
    this.engine.wakePreludes++;
    const started = () => {
      this.engine.wakePreludes--;
      this.engine.settleQuiesce();
    };
    return this.engine
      .flushPrerequisiteReleases()
      .then(() => this.engine.archivePlannerGrants())
      .then(
        () => {
          const drain = this.engine.ensureSweep("drain");
          started();
          return drain;
        },
        (error) => {
          started();
          throw error;
        },
      )
      .then(() => this.engine.quiesce("audit"))
      .then(() => this.engine.drainProjections({ cleanup: false }));
  }

  reconciliationSnapshot(): ReconciliationSweep {
    return {
      cursor: this.engine.sweepCursor,
      swept: this.engine.sweepStats.swept,
      tasks: this.engine.sweepStats.tasks,
      dirty:
        this.engine.sweepPending !== null || this.engine.sweepChain !== null,
      passes: this.engine.sweepStats.windows,
      lastPassAt: this.engine.sweepStats.lastPassAt,
    };
  }

  ensureSweep(mode: "window" | "drain"): Promise<void> {
    // A drain caller gets its own completion: the first full drain pass that
    // starts after this request, even while window passes keep the chain alive.
    const requested =
      mode === "drain"
        ? new Promise<void>((resolve, reject) => {
            this.engine.drainWaiters.push({ resolve, reject });
          })
        : null;
    if (this.engine.sweepChain) {
      // A running drain started before this request, so it cannot credit it:
      // another drain pass follows. A window request is covered by a drain.
      if (mode === "drain") {
        this.engine.sweepPending = "drain";
        return requested!;
      }
      if (this.engine.sweepMode === "drain") return this.engine.sweepChain;
      if (this.engine.sweepPending !== "drain")
        this.engine.sweepPending = "window";
      return this.engine.sweepChain;
    }
    this.engine.startSweepChain(mode);
    return requested ?? this.engine.sweepChain!;
  }

  startSweepChain(mode: "window" | "drain"): void {
    this.engine.sweepMode = mode;
    const chain = this.engine
      .scheduleLane("audit", LANE_PRIORITY_AUDIT, async () => {
        let current: "window" | "drain" = mode;
        // A drain capped before it reached every task continues in the next pass
        // with the coverage it carries; requests arriving meanwhile wait for a
        // fresh drain of their own after it.
        let carried: { waiters: DrainWaiter[]; visited: Set<string> } | null =
          null;
        for (;;) {
          this.engine.sweepMode = current;
          const credited: DrainWaiter[] =
            current !== "drain"
              ? []
              : carried
                ? carried.waiters
                : this.engine.drainWaiters.splice(0);
          const pass = await this.engine.auditPass(
            current === "drain",
            carried?.visited ?? new Set(),
          );
          carried = null;
          // A failed or stopped pass credits nothing: its waiters reject.
          const settled =
            pass.fault ?? (this.engine.stopped ? STOPPED_BEFORE_DRAIN() : null);
          if (settled) for (const waiter of credited) waiter.reject(settled);
          else if (pass.covered)
            for (const waiter of credited) waiter.resolve();
          else if (current === "drain")
            carried = { waiters: credited, visited: pass.visited };
          if (this.engine.stopped) break;
          const next =
            carried || this.engine.drainWaiters.length
              ? "drain"
              : this.engine.sweepPending;
          this.engine.sweepPending = null;
          if (!next) break;
          current = next;
        }
      })
      .catch(() => {
        /* the pass records its own fault on the store */
      });
    this.engine.sweepChain = chain.finally(() => {
      this.engine.sweepChain = null;
      this.engine.sweepMode = null;
      const pending = this.engine.sweepPending;
      this.engine.sweepPending = null;
      // A request that arrived while the chain was ending still runs: a new
      // chain covers it. Only a stopped engine rejects the uncovered drains.
      if (this.engine.stopped) {
        for (const waiter of this.engine.drainWaiters.splice(0))
          waiter.reject(STOPPED_BEFORE_DRAIN());
        return;
      }
      if (this.engine.drainWaiters.length || pending)
        this.engine.startSweepChain(
          this.engine.drainWaiters.length ? "drain" : pending!,
        );
    });
  }

  sweepOrder(): Task[] {
    // Never-started queued work is driven by dispatch and dependency wakes. A
    // queued task with a retained workspace, agent, or intent still has lifecycle
    // work and remains in the safety sweep.
    const byId = new Map(
      this.engine.store.activeCapacityTasks().map((task) => [task.id, task]),
    );
    for (const task of this.engine.store.dueHoldTasks())
      byId.set(task.id, task);
    const order = [...byId.values()].reverse();
    this.engine.sweepStats.tasks = order.length;
    return order;
  }

  async auditPass(
    drain: boolean,
    visited: Set<string> = new Set(),
  ): Promise<{ fault: Error | null; covered: boolean; visited: Set<string> }> {
    try {
      this.engine.resetAuditHostAvailability();
      this.engine.store.setMeta("engineError", "");
      // One diagnostic slot per pass for the per-host steps a fleet sweep must
      // not stall on: `HostPass` records a step that throws there.
      this.engine.store.setMeta("hostPassError", "");
      let covered = false;
      // The hourly and daily store chores and the periodic owner/lane passes
      // keep their own cadence; the sweep runs one maintenance pass.
      // Audit A6: one bounded labelled inventory answers every identity this
      // pass observes, and retired workers are re-read on their own slow cadence.
      // A list that cannot be walked to its end answers nothing, so every
      // identity falls back to the narrow read and no inactivity is inferred.
      let inventory: ReadonlyMap<string, AgentObservation> | null = null;
      const finishedCatchUp = new Map<string, Task>();
      const unavailableHosts = new Set<string>();
      const allTasks = this.engine.store.tasks();
      const hosts = new Set([
        ...this.engine.hostIds(),
        ...allTasks.flatMap((task) => (task.hostId ? [task.hostId] : [])),
      ]);
      for (const host of hosts) {
        let passed: Awaited<ReturnType<HostPass["run"]>> | null;
        try {
          passed = await this.engine.withHost(host, async () => {
            // Tom, 2026-11-14 (T3 lane v18, host dropout option 1: wait): one durable
            // record of when this host went away, kept whether or not it has tasks.
            this.engine.hostOutages.observe(
              host,
              this.engine.hostAvailable(host),
            );
            if (!this.engine.hostAvailable(host)) return null;
            return this.hostPass.run(host);
          });
        } catch (error) {
          if (!hostFaultHost(error)) throw error;
          // A connected registry claim can still fail at the transport boundary.
          // Keep this host's tasks on the existing outage wait for this pass, and
          // continue the fleet sweep without turning the host loss into engineError.
          recordHostFailure(this.engine.adapter, host, error);
          unavailableHosts.add(host);
          continue;
        }
        // Nothing is read from a host that is away: the wait itself is the stop.
        if (!passed) {
          recordHostFailure(this.engine.adapter, host, undefined);
          unavailableHosts.add(host);
          continue;
        }
        // Spec 066 R1/R6 (C2): the pass's reading of one host, shared with that
        // host's task visits. A step that failed at the transport boundary means the
        // host did not answer, even though the registry still claims the connection:
        // the reading is the failure, not the claim. So this host's tasks keep their
        // host-scoped wait for the pass, and no other host's visit sees it.
        if (!passed.transportAnswered) {
          unavailableHosts.add(host);
          recordHostFailure(
            this.engine.adapter,
            host,
            new Error(`Host ${host} did not answer its pass`),
          );
        } else {
          // Never-started queue heads are absent from the lifecycle window, but
          // their host wait must settle before they can reserve a slot again.
          for (const task of allTasks) {
            if (
              task.hostId === host &&
              task.phase === "queued" &&
              (task.resolution.hostWait ||
                task.resolution.stop?.reason === "host_unavailable")
            )
              this.engine.hostWait(this.engine.store.task(task.id));
          }
        }
        if (passed.inventory) inventory = passed.inventory;
        for (const [id, task] of passed.finishedCatchUp)
          finishedCatchUp.set(id, task);
      }
      // A failed host already spent its per-pass observation budget; do not
      // query it again while refreshing project notice recipients.
      await this.engine.resolution.refreshResponsibleThreads(this.engine.store.projects(), unavailableHosts);
      await this.maintenance.run();
      this.engine.clearRetiredInvalidations();
      // Engine restart scans incomplete dispositions before normal task
      // resolution. The fence persists across restarts; retry reconciles the
      // same persisted effects and never launches general recovery. The sync
      // pre-check keeps passes without a fence on their exact previous timing.
      const preflight = this.engine.store.maintenanceTasks(true);
      if (
        !this.engine.stopped &&
        preflight.some((task) => isDispositionActive(task))
      )
        await this.fleetStep("resumeDispositions", () =>
          resumeDispositions(this.engine.store, this.engine.dispositionDeps()),
        );
      // Queue #650: unresolved paused-stop markers resume in their own threads
      // before recovery reads the same threads, so a fresh resume never races
      // an armed failover.
      if (!startsNoRuns(this.engine.store, this.engine.stopped))
        await this.fleetStep("resumePausedStops", () =>
          this.engine.resumePausedStops(),
        );
      if (!startsNoRuns(this.engine.store, this.engine.stopped))
        await this.fleetStep("recoverExhaustedWorkers", () =>
          this.engine.recoverExhaustedWorkers(),
        );
      // Retired-errored archive is not drain settlement: it waits for unpause
      // (same as main). Running it under pause doubled the A6 retired-worker
      // observe. It does not hold `drained`.
      if (!startsNoRuns(this.engine.store, this.engine.stopped)) {
        const archiveHosts = new Set(
          this.engine.store
            .activeCapacityTasks()
            .flatMap((task) => (task.hostId ? [task.hostId] : [])),
        );
        for (const host of archiveHosts)
          await this.fleetStep("archiveRetiredErroredAgents", () =>
            this.engine.withHost(host, () =>
              archiveRetiredErroredAgents(this.engine, host),
            ),
          );
      }
      // Round 4: owner verbs recorded while paused or held apply once that clears.
      await this.fleetStep("applyDeferredOwnerVerbs", () =>
        this.engine.applyDeferredOwnerVerbs(),
      );
      // Task 1218: an amendment recorded while its host was unreachable is delivered
      // by the next pass; an attempted send with an unknown outcome never is.
      await this.fleetStep("deliverPendingBriefAmendments", () =>
        this.engine.deliverPendingBriefAmendments(),
      );
      if (this.engine.adapter.originAgent)
        await this.fleetStep("origins", () =>
          this.engine.resolution.origins.pass(),
        );
      // Keep the ordinary pass timing unchanged: only reach for the checkpoint
      // reconciler when a persisted continuation intent actually awaits delivery.
      if (
        preflight.some(
          (task) =>
            task.checkpoints.intent &&
            task.checkpoints.intent.status !== "delivered",
        )
      )
        await this.fleetStep("checkpoints", () =>
          this.engine.resolution.checkpoints.pass(),
        );
      await this.fleetStep("continueAwaitingReviewers", () =>
        this.engine.continueAwaitingReviewers(preflight),
      );
      await this.fleetStep("lifecycle", () =>
        this.engine.lifecycle.enqueuePass(),
      );
      const releasedTasks = new Set<string>();
      await this.fleetStep("observe", () =>
        this.engine.resolution.observe(inventory, undefined, (taskId) => {
          if (this.engine.scheduleLifecycleFollowUp(taskId))
            releasedTasks.add(taskId);
          this.engine.wakeCapacityWaiter(taskId);
        }),
      );
      // A callback-free worker may still have completed and pushed the one
      // queue-owned branch PR. Reconcile that exact identity before recovery
      // spends a coordinator run. The retained worker still owes an
      // authenticated ready_for_review callback on a newly minted run.
      for (const task of (this.engine.adapter.findOpenBranchPr
        ? this.engine.store.activeCapacityTasks()
        : []
      ).filter(
        (task) =>
          this.engine.taskHostAvailable(task) &&
          task.agentId &&
          !completionReportsPr(task) &&
          !task.prUrl &&
          !task.prHead &&
          !task.resumePrNumber &&
          !this.engine.resolution.recovery.busy(task) &&
          ["working", "blocked", "error", "needs_attention"].includes(
            task.phase,
          ),
      )) {
        await boundQuantum(
          this.engine
            .scheduleLane(`task:${task.id}`, LANE_PRIORITY_TASK, async () => {
              try {
                await this.engine.reconcile(this.engine.store.task(task.id));
              } catch (error) {
                this.engine.noteStepFailure(task.id, error);
              }
              // The quantum records its own faults; a lane-level failure here means
              // shutdown discarded the queued quantum, so the audit simply stops.
            })
            .catch(() => {}),
          () => this.recordQuantumOutage(task.id),
        );
      }
      // One lifecycle quantum per task on an exclusive key. A control or
      // operation for the same task queues behind this quantum instead of
      // racing it, while unrelated keys keep awaiting remote effects
      // concurrently. The audit yields to the event loop between bounded
      // chunks so acceptance and reads stay responsive.
      const reconciled = new Set<string>();
      const order = [
        ...new Map(
          [...this.engine.sweepOrder(), ...finishedCatchUp.values()].map(
            (task) => [task.id, task],
          ),
        ).values(),
      ];
      this.engine.sweepStats.tasks = order.length;
      const cursorAt = this.engine.sweepCursor
        ? order.findIndex((task) => task.id === this.engine.sweepCursor)
        : -1;
      const resume = cursorAt + 1 >= order.length ? 0 : cursorAt + 1;
      // A window reconciles one page from the cursor. A drain walks, from the
      // cursor round to the fleet's start, every task it has not yet visited:
      // the visited set carries across capped passes, so a task that finishes or
      // leaves the order never stands in for one that is still live.
      const sequence = drain
        ? [...order.slice(resume), ...order.slice(0, resume)].filter(
            (task) => !visited.has(task.id),
          )
        : order;
      let index = drain ? 0 : resume;
      let windows = 0;
      for (;;) {
        if (index >= sequence.length) break;
        const window = sequence.slice(index, index + SWEEP_WINDOW);
        const pending: Promise<void>[] = [];
        for (const candidate of window) {
          if (this.engine.stopped)
            return { fault: null, covered: false, visited };
          visited.add(candidate.id);
          const task = this.engine.store.task(candidate.id);
          if (["done", "cancelled"].includes(task.phase)) {
            if (finishedCatchUp.has(task.id)) {
              pending.push(
                boundQuantum(
                  this.engine.scheduleLane(
                    `task:${task.id}`,
                    LANE_PRIORITY_TASK,
                    async () => {
                      const current = this.engine.store.task(task.id);
                      if (
                        !current.hostId ||
                        !this.engine.taskHostAvailable(current)
                      )
                        return;
                      await this.engine.withHost(current.hostId, () =>
                        catchUpFinishedTaskThreads(
                          this.engine.store,
                          this.engine.adapter,
                          current.id,
                        ),
                      );
                    },
                  ),
                  () => this.recordQuantumOutage(task.id),
                ),
              );
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
            continue;
          }
          // Spec 058 budgets (nucleus#1153): the wall clock pauses while the host, a
          // workspace or a dispatch hold keeps the task from progress — including a
          // task whose quantum this sweep cannot start at all. The host wait is
          // recorded first, so the pause is dated from the outage's own start.
          //
          // The visit settles the task's host-scoped wait from this host's own
          // reading (Spec 066 R1/R3/R6, C2): the one settlement (`clearHostWait`)
          // clears an outage wait and a transport deferral together, and only when
          // the host answered. A host that did not answer, or another host's
          // failure, leaves this wait exactly as it is.
          let hostWait: string | null;
          try {
            hostWait = this.engine.hostWait(task);
          } catch (error) {
            // The host stopped answering between its pass and this visit. That is
            // this task's own host going away, not the fleet's: hold this task and
            // keep visiting the rest of the order (Spec 066 R6).
            if (!hostFaultHost(error)) throw error;
            if (task.hostId) {
              this.engine.markAuditHostUnavailable(task.hostId);
              this.engine.hostOutages.observe(task.hostId, false);
            }
            reconciled.add(task.id);
            continue;
          }
          this.engine.resolution.settleBudgetClock(task);
          reconciled.add(task.id);
          // Nothing is sent to a host that is away: no quantum, no recovery, no
          // stall check and no escalation. The wait itself is the whole stop.
          if (hostWait) continue;
          if (releasedTasks.has(task.id)) continue; // The release already queued this task.
          pending.push(
            boundQuantum(this.engine.scheduleTaskQuantum(task.id), () =>
              this.recordQuantumOutage(task.id),
            ),
          );
          // Independent lanes may await concurrently. Paseo and process
          // admission still bound the actual resources; same-task lanes stay FIFO.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        await Promise.all(pending);
        index += window.length;
        const wrapped = !drain && index >= sequence.length;
        // The durable cursor resumes the next pass where this one stopped and
        // resets once a window wraps or a drain has covered the fleet.
        this.engine.sweepCursor = wrapped ? null : (window.at(-1)?.id ?? null);
        this.engine.sweepStats.windows++;
        this.engine.sweepStats.swept += window.length;
        this.engine.sweepStats.lastPassAt = now();
        windows++;
        // One bounded page per window. An explicit drain keeps going until it has
        // visited every task once, or its window cap continues it in the next pass;
        // a safety-tick window reconciles one page and yields to every other lane.
        if (
          this.engine.stopped ||
          !drain ||
          windows >= this.engine.maxSweepWindows
        )
          break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      // Coverage is judged against this pass's fleet: every task in it visited.
      covered = !drain || order.every((task) => visited.has(task.id));
      if (drain && covered) this.engine.sweepCursor = null;
      await this.fleetStep("deliverNotices", () =>
        this.engine.resolution.deliverNotices(),
      );
      await this.fleetStep("deliverQueuedMessages", () =>
        this.engine.resolution.deliverQueuedMessages(),
      );
      await this.fleetStep("resumeAskQuestions", () =>
        this.engine.resolution.resumeAskQuestions(),
      );
      await this.fleetStep("raiseOperatorQuestions", () =>
        this.engine.resolution.raiseOperatorQuestions(),
      );
      await this.fleetStep("delegateNativeQuestions", () =>
        this.engine.resolution.delegateNativeQuestions(),
      );
      await this.fleetStep("resumeResponsibleAnsweredQuestions", () =>
        this.engine.resolution.resumeResponsibleAnsweredQuestions(),
      );
      await this.fleetStep("deliverHoldNotices", () =>
        this.engine.resolution.deliverHoldNotices(),
      );
      await this.fleetStep("deliverDecisionNotices", () =>
        this.engine.resolution.deliverDecisionNotices(),
      );
      await this.fleetStep("deliverDrainNotices", () =>
        this.engine.resolution.deliverDrainNotices(),
      );
      // The one long-outage notice: raised once per outage past the dispatch-limits
      // bound, then delivered through the durable notice path.
      this.engine.hostOutages.raiseNotices();
      await this.fleetStep("deliverHostOutageNotices", () =>
        this.engine.resolution.deliverHostOutageNotices(),
      );
      if (this.engine.stopped) return { fault: null, covered: false, visited };
      if (startsNoRuns(this.engine.store, this.engine.stopped)) {
        for (const id of reconciled) this.engine.enqueueTitle(id);
        return { fault: null, covered, visited };
      }
      await this.fleetStep("dispatchQueued", () =>
        this.engine.dispatchQueued(),
      );
      for (const id of reconciled) this.engine.enqueueTitle(id);
      return { fault: null, covered, visited };
    } catch (error) {
      this.engine.store.setMeta("engineError", String(error));
      return {
        fault: error instanceof Error ? error : new Error(String(error)),
        covered: false,
        visited,
      };
    }
  }
}
