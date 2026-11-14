import { DISPOSITION_CONTROL_REFUSAL, REMOVED_TASK_REFUSAL, stopStateRefusal } from './control-refusals';
import type { Run, Task, TaskControlInput } from "../../shared/contracts";
import { holdsOf, isDispositionActive, taskControlInputSchema } from "../../shared/contracts";
import { dispatchBlocked, DISPATCH_HELD_REASON } from "../dispatch/capacity";
import type { Engine } from "../engine";
import { holdPatch, releasePatch, OPERATOR_HOLD_OWNER, OWNER_STOP_HOLD_PREFIX } from "../merge/merge-hold";
import type { RouteRole } from "./owner-verbs";
import { reviewContinuationState, reviewResultFencesRun } from "../review/review-continuation";
import { DurableFenceRefusal } from "../intake/run-settlement";
import { now } from "../store/store";

/** How long a refused automatic reviewer continuation waits before Queue tries it again. */
const REVIEW_AUTO_CONTINUE_RETRY_MS = 5 * 60_000;

/**
 * The owner's `stop` verb, the hold it places and yields, recorded owner verbs
 * and their replay, and the reviewer's automatic continuation. Same-name `Engine`
 * methods delegate here. `store`, `adapter` and `resolution` read the engine per
 * call: tests replace the adapter.
 */
export class OwnerStop {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get resolution() { return this.engine.resolution; }

  /** Round 4: the task's dispatch hold is the one an owner `stop` placed. */
  ownerStopHold(task: Task): boolean {
    const hold = holdsOf(task).dispatch;
    return Boolean(hold && hold.reason.startsWith(OWNER_STOP_HOLD_PREFIX));
  }

  ownerStopNamesRun(task: Task, runId: string | null | undefined): boolean {
    if (!runId) return false;
    let stopped = false;
    for (const event of this.store.eventsAll(task.id)) {
      try {
        const detail = JSON.parse(event.detail) as { runIds?: unknown; runId?: unknown };
        if (event.kind === "owner_stopped" && Array.isArray(detail.runIds) && detail.runIds.includes(runId)) stopped = true;
        if (event.kind === "owner_restart_instruction_sent" && detail.runId === runId) stopped = false;
      } catch { /* historical audit rows remain readable */ }
    }
    return stopped;
  }

  /** A deferred restart can supersede only the owner stop that preceded its recorded instruction. */
  deferredRestartSupersedesOwnerStop(task: Task): boolean {
    const deferred = task.resolution.deferredVerb;
    const targetRunId = deferred?.target?.runId;
    if (!deferred || deferred.input.action !== "restart" || !targetRunId || !this.ownerStopHold(task)) return false;
    const events = this.store.eventsAll(task.id);
    const deferredEvent = events.findLast(event => {
      if (event.kind !== "owner_verb_deferred") return false;
      try {
        const detail = JSON.parse(event.detail) as { action?: unknown; target?: { runId?: unknown } | null };
        return detail.action === "restart" && detail.target?.runId === targetRunId;
      } catch { return false; }
    });
    const stopEvent = events.findLast(event => {
      if (event.kind !== "owner_stopped") return false;
      try {
        const detail = JSON.parse(event.detail) as { runIds?: unknown };
        return Array.isArray(detail.runIds) && detail.runIds.includes(targetRunId);
      } catch { return false; }
    });
    return Boolean(deferredEvent && stopEvent && stopEvent.id < deferredEvent.id);
  }

  /**
   * Round 4 (Tom, 2026-10-19): an owner verb applies now; what it would start
   * waits for Queue to be unpaused and the task unheld. The owner's own stop
   * hold does not hold back the owner's own next verb — but it does hold back a
   * coordinator and a verb recorded before the stop.
   */
  dispatchWaitsFor(task: Task, ownerStopYields = false, inFlight = false): "paused" | "held" | null {
    if (this.engine.stopped || (!inFlight && this.store.getMeta("paused"))) return "paused";
    if (dispatchBlocked(task) && !(this.ownerStopHold(task) && (ownerStopYields || this.engine.isOwnerCall()))) return "held";
    return null;
  }

  /** Round 4: the owner's next restart or move supersedes their own stop. Returns whether a hold was released. */
  releaseOwnerStopHold(taskId: string, allowDeferredReplay = false): boolean {
    if (!this.engine.isOwnerCall() && !allowDeferredReplay) return false;
    const task = this.store.task(taskId);
    if (!this.ownerStopHold(task)) return false;
    this.store.update(task.id, releasePatch(task, "dispatch"), "release", "Owner stop released by the owner's next verb");
    return true;
  }

  /**
   * Round 4: record an owner verb whose effect is an immediate delivery, to apply
   * once the wait clears, bound to the exact run (and checkpoint) it was for.
   */
  deferOwnerVerb(task: Task, input: TaskControlInput, why: "paused" | "held", target: { runId: string; checkpointOrdinal?: number; head?: string } | null): Task {
    const { version: _version, ...rest } = input;
    return this.store.update(task.id, {
      reason: `Owner ${input.action} recorded; it is delivered once Nucleus is ${why === "paused" ? "unpaused" : "released"}`,
      resolution: { ...task.resolution, deferredVerb: { input: rest as Record<string, unknown>, at: now(), why, target } },
    }, "owner_verb_deferred", JSON.stringify({ action: input.action, role: input.role ?? null, why, target }));
  }

  /** Round 4: drop the recorded verb if it is still the one read (`at`), with one event. */
  private clearDeferredVerb(taskId: string, at: string, kind: string, detail: string): void {
    this.store.transaction(() => {
      const current = this.store.task(taskId);
      if (current.resolution.deferredVerb?.at !== at) return;
      this.store.update(taskId, { resolution: { ...current.resolution, deferredVerb: null } }, kind, detail.slice(0, 2000));
    });
  }

  /** Round 4: why a recorded verb's target no longer holds, or null. */
  private deferredTargetChanged(task: Task, target: { runId: string; checkpointOrdinal?: number; head?: string } | null): string | null {
    if (!target) return null;
    if (task.runId === target.runId && task.agentId && !this.store.run(target.runId)) return null;
    if (task.resolution.currentRunId !== target.runId) return `its run ${target.runId} is no longer current`;
    const run = this.store.run(target.runId);
    if (!run || run.released) return `its run ${target.runId} was released`;
    if (target.checkpointOrdinal !== undefined && run.reviewCheckpoints?.at(-1)?.ordinal !== target.checkpointOrdinal) return `checkpoint ${target.checkpointOrdinal} is no longer the latest`;
    if (target.head !== undefined && run.head !== target.head) return `its head ${target.head} changed`;
    return null;
  }

  /** The last refusal per reviewer run and checkpoint; memory only, so a restart retries at once. */
  private readonly autoContinueRefusals = new Map<string, { detail: string; at: number; repeated: boolean }>();
  /**
   * A reviewer checkpoint continues by itself, as a worker checkpoint does (Tom,
   * 2026-10-31): once the reader's turn has ended, Queue applies the ordinary
   * retained `restart role=reviewer`, so the delivery keeps its one admission
   * path and at-most-once identity. It runs as Queue, not the owner, so an
   * owner's stop hold still holds it. A refusal waits for a later pass.
   *
   * The ordinary observation pass skips a reader behind a review fence, so its
   * saved activity is stale here; the reader's own idle observation is the
   * trigger. Anything else (busy, permission, closed, unreadable) waits.
   */
  async continueAwaitingReviewers(tasks: Task[], scopedHost?: string): Promise<void> {
    if (this.engine.stopped) return;
    if (!scopedHost) {
      for (const host of new Set(tasks.flatMap(task => task.hostId ? [task.hostId] : [])))
        await this.engine.withHost(host, () => this.continueAwaitingReviewers(tasks, host));
      return;
    }
    const eligible = (taskId: string) => {
      const task = this.store.task(taskId);
      if (task.hostId !== scopedHost) return null;
      if (!this.engine.taskHostAvailable(task)) return null;
      if (task.removedAt || isDispositionActive(task) || dispatchBlocked(task) || task.resolution.deferredVerb) return null;
      if (reviewContinuationState(task, this.store) !== "awaiting") return null;
      const run = this.store.run(task.resolution.currentRunId!);
      const checkpoint = run?.reviewCheckpoints?.at(-1);
      return run?.agentId && checkpoint ? { task, run, checkpoint } : null;
    };
    for (const initial of tasks) {
      if (this.engine.stopped) return;
      const before = eligible(initial.id);
      if (!before) continue;
      // A refusal is retried on the next pass; the same refusal twice in a row
      // waits out a retry interval before Queue observes the reader and runs the
      // restart checks (a forge read among them) again.
      const key = `${before.run.id}:${before.checkpoint.ordinal}`;
      let refused = this.autoContinueRefusals.get(key);
      const fenceCleared = Boolean(refused?.detail.includes('Another unreleased run or changed run identity')
        && this.store.runs(before.task.id).every(run => run.released || run.id === before.run.id))
        || Boolean(refused?.detail.includes('unresolved task incident or recovery fence')
        && !before.task.resolution.attention && !before.task.resolution.recoveryActive
        && (!before.task.resolution.recovery || before.task.resolution.recovery.status === 'resolved')
        && (!before.task.resolution.incident || before.task.resolution.incident.status === 'resolved')
        && (!before.task.resolution.stalledTurnStop || before.task.resolution.stalledTurnStop.status === 'completed'));
      if (fenceCleared) {
        this.autoContinueRefusals.delete(key);
        refused = undefined;
      }
      if (refused && refused.repeated && Date.now() - refused.at < REVIEW_AUTO_CONTINUE_RETRY_MS) continue;
      const state = await this.engine.host.observe(before.run.agentId!).catch(() => null);
      if (!state || state.id !== before.run.agentId || state.workspaceId !== before.run.workspaceId || state.status !== "idle"
        || state.active || state.permissions || state.activeTurnId) continue;
      const found = eligible(initial.id);
      if (!found || found.run.id !== before.run.id || found.checkpoint.ordinal !== before.checkpoint.ordinal) continue;
      const { task, run, checkpoint } = found;
      const reason = `Queue continues the reviewer from checkpoint ${checkpoint.ordinal}`;
      const markFencedReaderStopped = () => {
        const latestRun = this.store.run(run.id);
        if (latestRun && !latestRun.released && !latestRun.completion && latestRun.status !== 'superseded'
          && reviewResultFencesRun(this.store, this.store.task(task.id), latestRun)) {
          const observedAt = new Date().toISOString();
          this.store.putRun({ ...latestRun, status: 'stopped', active: false, idleSince: latestRun.idleSince ?? observedAt, lastObservedAt: observedAt });
        }
      };
      try {
        await this.engine.replayingDeferredVerb.run(true, () => this.engine.performTaskControl(taskControlInputSchema.parse({
          taskId: task.id, version: task.version, action: "restart", role: "reviewer", reason }) as TaskControlInput));
        // A hold or pause that landed meanwhile records the verb instead of sending it.
        const sent = ["reserved", "continuing"].includes(reviewContinuationState(this.store.task(task.id), this.store) ?? "");
        if (sent) this.store.event(task.id, "review_auto_continued", `${checkpoint.ordinal} run ${run.id} at ${run.head}`);
        else markFencedReaderStopped();
      } catch (error) {
        const detail = `${checkpoint.ordinal} run ${run.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000);
        markFencedReaderStopped();
        const last = this.autoContinueRefusals.get(`${run.id}:${checkpoint.ordinal}`);
        this.autoContinueRefusals.set(`${run.id}:${checkpoint.ordinal}`, { detail, at: Date.now(), repeated: last?.detail === detail });
        const previous = this.store.events(task.id).findLast(event => event.kind === "review_auto_continue_deferred");
        if (previous?.detail !== detail) this.store.event(task.id, "review_auto_continue_deferred", detail);
      }
    }
  }

  /**
   * Round 4: apply each recorded owner verb whose wait has cleared, against the
   * task's current version. A replay is not the owner's next verb: any hold,
   * including an owner stop placed later, keeps it waiting. A verb whose target
   * changed, or that no longer applies, is refused once and never retried. The
   * record is cleared only after the verb has been handled, so a crash in
   * between leaves it to replay again; the handlers' own durable delivery
   * records keep that from sending twice.
   */
  async applyDeferredOwnerVerbs(scopedHost?: string): Promise<void> {
    if (this.engine.stopped) return;
    const ids = (this.store.db.prepare("SELECT id FROM tasks WHERE json_extract(data,'$.resolution.deferredVerb') IS NOT NULL").all() as Array<{ id: string }>).map(row => row.id);
    if (!scopedHost) {
      for (const host of new Set(ids.flatMap(id => { const host = this.store.task(id).hostId; return host ? [host] : []; })))
        await this.engine.withHost(host, () => this.applyDeferredOwnerVerbs(host));
      return;
    }
    for (const id of ids) {
      const task = this.store.task(id);
      if (task.hostId !== scopedHost) continue;
      if (!this.engine.taskHostAvailable(task)) continue;
      const deferred = task.resolution.deferredVerb;
      if (!deferred || task.removedAt || dispatchBlocked(task) && !this.deferredRestartSupersedesOwnerStop(task)) continue;
      // Older versions recorded checkpoint continuations during pause. Replay
      // only that bound delivery while paused; new starts remain deferred.
      if (this.store.getMeta("paused")) {
        const input = deferred.input;
        const target = deferred.target;
        const isContinuation = target?.checkpointOrdinal != null && target.runId === task.resolution.currentRunId
          && input.fresh !== true && (input.action === "restart" && input.role === "reviewer"
            || input.action === "move" && input.to === "review");
        if (!isContinuation) continue;
      }
      const changed = this.deferredTargetChanged(task, deferred.target ?? null);
      if (changed) { this.clearDeferredVerb(id, deferred.at, "deferred_verb_refused", `${String(deferred.input.action)}: ${changed}`); continue; }
      this.store.event(id, "owner_verb_resumed", JSON.stringify({ action: deferred.input.action, recordedAt: deferred.at }));
      try {
        await this.engine.replayingDeferredVerb.run(true, () =>
          this.engine.performTaskControl(taskControlInputSchema.parse({ ...deferred.input, version: this.store.task(id).version }) as TaskControlInput));
        this.clearDeferredVerb(id, deferred.at, "owner_verb_applied", String(deferred.input.action));
      } catch (error) {
        this.clearDeferredVerb(id, deferred.at, "deferred_verb_refused", `${String(deferred.input.action)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Round 4 `stop` (Tom, 2026-10-19): halt the task's live work now and park it.
   * Every busy turn of the task's runs (or of one role's) is cancelled durably,
   * and an owner dispatch hold keeps anything new from starting. Run state is
   * left as it is: `restart` continues the same agent, `move` displaces it, and
   * `release` lets dispatch carry on. Only a durable side effect refuses.
   */
  async stopTask(input: TaskControlInput): Promise<Task> {
    const reason = (input.reason ?? "").trim();
    if (!reason) throw Error("stop requires a reason");
    return this.engine.control(async () => {
      const task = this.store.task(input.taskId);
      if (task.removedAt) throw Error(REMOVED_TASK_REFUSAL);
      this.engine.requireOwnerControlCurrent(task, input.version, "Task changed; refresh before retrying");
      if (task.resolution.integrationTurn && (isDispositionActive(task) || ["done", "cancelled"].includes(task.phase) || task.resolution.mergedCommit))
        return this.store.update(task.id, { resolution: { ...task.resolution, integrationTurn: null } },
          'integration_turn_released', `stop: ${reason}`);
      const refusal = stopStateRefusal(task);
      if (refusal) throw Error(refusal);
      const role = input.role as RouteRole | undefined;
      const roleOf = (run: Run): RouteRole => run.role === "reviewer" ? "reviewer" : run.role === "revision" ? "worker" : "coordinator";
      let collectionIssue = '';
      const finished = await this.engine.collectVerbFinishedRuns(task.id, run => role !== undefined && roleOf(run) !== role, { displace: true })
        .catch(error => {
          if (!task.resolution.integrationTurn) throw error;
          collectionIssue = String(error);
          return { settleable: [], fenced: [], live: [] };
        });
      if (finished.fenced.length && !task.resolution.integrationTurn) throw new DurableFenceRefusal(this.engine.displaceRefusal(finished.fenced[0]!));
      const busy = [...finished.live];
      let stopIssue = [collectionIssue, ...finished.fenced.map(item => this.engine.displaceRefusal(item))].filter(Boolean).join('; ');
      // The initial worker lives on the task row, never as a Run.
      const runRows = this.store.runs(task.id);
      if ((role === undefined || role === "worker") && task.agentId && task.workspaceId
        && !runRows.some(run => !run.released && run.agentId === task.agentId)) {
        // Only the identity fields the observation and cancellation read.
        const initial = { id: task.runId ?? `initial-worker-${task.id}`, taskId: task.id, role: "revision",
          agentId: task.agentId, workspaceId: task.workspaceId } as Run;
        try { if (await this.engine.displacedRunBusy(initial)) busy.push(initial); }
        catch (error) { if (!task.resolution.integrationTurn) throw error; stopIssue = [stopIssue, String(error)].filter(Boolean).join('; '); }
      }
      let confirmedStops = busy;
      try { await this.engine.cancelDisplacedTurns(task.id, busy, "stop"); }
      catch (error) {
        if (!task.resolution.integrationTurn) throw error;
        confirmedStops = [];
        stopIssue = [stopIssue, `Turn cancellation was not confirmed: ${String(error)}`].filter(Boolean).join('; ');
      }
      const current = this.store.task(task.id);
      // A merge already requested is unknown-delivery territory (Queue #531): Queue
      // cannot withdraw a request it has sent, so the stop says plainly that the
      // merge may still land instead of implying that it cancelled the merge.
      const mergeRequested = Boolean(current.resolution.mergeIntent && !current.resolution.mergedCommit);
      const mergeHead = current.resolution.mergeHead ?? current.prHead ?? 'the recorded head';
      const mergeNote = mergeRequested
        ? ` The merge was already requested for ${mergeHead} before this stop, so it may still land; Nucleus cannot cancel a request it already sent`
        : '';
      const holdReason = `Owner stop: ${reason}${mergeNote}${stopIssue ? ` Remaining activity needs attention: ${stopIssue}` : ''}`.slice(0, 4000);
      // An existing dispatch hold stands: the stop never renews one the owner
      // already holds.
      if (!holdsOf(current).dispatch)
        this.store.update(current.id, holdPatch(current, "dispatch", input.caller ?? OPERATOR_HOLD_OWNER, holdReason, null), "hold", holdReason);
      // Spec 050 (Queue #396, papercut 755cf03a): the accepted stop records the
      // held stop with its fence in the same control quantum, so the response,
      // task detail and every raw reader name the hold at once instead of the wait
      // the task was in when it was stopped; the reconciler would only record it
      // later. The fence patch and this wait are two store updates serialized by
      // the task's control lane, not one atomic SQLite transaction: a reader on
      // another connection can observe the fence before the held stop. The release
      // that removes the fence retires this record with it.
      this.resolution.waiting(this.store.task(task.id), `${DISPATCH_HELD_REASON}${mergeNote}${stopIssue ? ` Remaining activity needs attention: ${stopIssue}` : ''}`, "held");
      let held = this.store.task(task.id);
      // Releasing the turn does not cancel an already sent merge request.
      if (held.resolution.integrationTurn) {
        held = this.store.update(held.id, { resolution: { ...held.resolution, integrationTurn: null } },
          "integration_turn_released", `stop: ${reason}`);
      }
      const stoppedRunIds = new Set(busy.map(run => run.id));
      for (const run of runRows) {
        const targeted = role === undefined || (role === "reviewer" ? run.role === "reviewer" : role === "worker" ? run.role === "revision" : !["reviewer", "revision"].includes(run.role));
        if (targeted && !run.released && !run.completion) stoppedRunIds.add(run.id);
      }
      if ((role === undefined || role === "worker") && task.runId && task.agentId
        && !runRows.some(run => run.id === task.runId)) stoppedRunIds.add(task.runId);
      this.store.event(task.id, "owner_stopped", JSON.stringify({ role: role ?? null, reason, runIds: [...stoppedRunIds], cancelled: confirmedStops.map(run => ({ runId: run.id, role: run.role, agentId: run.agentId })),
        ...(mergeRequested ? { mergeAlreadyRequested: { head: current.resolution.mergeHead ?? null, requestedAt: current.resolution.mergeRequestedAt ?? null } } : {}) }));
      // A stop supersedes any verb recorded before it.
      const recorded = held.resolution.deferredVerb;
      if (recorded) {
        this.clearDeferredVerb(task.id, recorded.at, "deferred_verb_dropped", `${String(recorded.input.action)}: superseded by stop`);
        return this.store.task(task.id);
      }
      return held;
    }, `task:${input.taskId}`);
  }
}
