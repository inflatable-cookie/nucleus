import { REMOVED_TASK_REFUSAL, stopStateRefusal } from './control-refusals';
import type { Run, Task, TaskControlInput } from "../../shared/contracts";
import { holdsOf, isDispositionActive } from "../../shared/contracts";
import { dispatchBlocked, DISPATCH_HELD_REASON } from "../dispatch/capacity";
import type { Engine } from "../engine";
import { holdPatch, OPERATOR_HOLD_OWNER, OWNER_STOP_HOLD_PREFIX, releasePatch } from "../merge/merge-hold";
import type { RouteRole } from "./owner-verbs";
import { ownerStoppedRunIds } from "./owner-facts";
import { DurableFenceRefusal } from "../intake/run-settlement";

/**
 * The owner's `stop` verb and the dispatch hold it places and yields. Same-name
 * `Engine` methods delegate here. The recorded owner verbs and their replay live
 * in `deferred-verbs.ts`, and the reviewer's automatic continuation in
 * `reviewer-auto-continue.ts`. `store`, `adapter` and `resolution` read the
 * engine per call: tests replace the adapter.
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

  /** Whether the record says this exact run was stopped by the owner and not restarted since. */
  ownerStopNamesRun(task: Task, runId: string | null | undefined): boolean {
    return Boolean(runId && ownerStoppedRunIds(this.store.eventsAll(task.id)).has(runId));
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
      // nucleus#1195: a live proof executor is never interrupted by an owner stop.
      // Its turn is source-immutable and mid-report, and the stop's fence already
      // keeps anything new from starting, so the stop applies the dispatch hold
      // and leaves the executor's turn alone until it reports or ends. This holds
      // for a stop that names no role ("Stop and keep the work") and for one that
      // names a different role than the executor's.
      const liveExecutors = this.store.runs(task.id).filter(run => run.role === "executor" && !run.released && !run.completion);
      let collectionIssue = '';
      const finished = await this.engine.collectVerbFinishedRuns(task.id,
        run => run.role === "executor" || role !== undefined && roleOf(run) !== role, { displace: true })
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
        // The live executor keeps its turn: the dispatch hold fences new work only.
        if (run.role === "executor") continue;
        const targeted = role === undefined || (role === "reviewer" ? run.role === "reviewer" : role === "worker" ? run.role === "revision" : !["reviewer", "revision"].includes(run.role));
        if (targeted && !run.released && !run.completion) stoppedRunIds.add(run.id);
      }
      if ((role === undefined || role === "worker") && task.runId && task.agentId
        && !runRows.some(run => run.id === task.runId)) stoppedRunIds.add(task.runId);
      this.store.event(task.id, "owner_stopped", JSON.stringify({ role: role ?? null, reason, runIds: [...stoppedRunIds], cancelled: confirmedStops.map(run => ({ runId: run.id, role: run.role, agentId: run.agentId })),
        // A proof executor's turn is left to report; the hold still fences dispatch.
        ...(liveExecutors.length ? { executorContinues: liveExecutors.map(run => ({ runId: run.id, agentId: run.agentId })) } : {}),
        ...(mergeRequested ? { mergeAlreadyRequested: { head: current.resolution.mergeHead ?? null, requestedAt: current.resolution.mergeRequestedAt ?? null } } : {}) }));
      // A stop supersedes any verb recorded before it.
      const recorded = held.resolution.deferredVerb;
      if (recorded) {
        this.engine.dropDeferredOwnerVerb(task.id, recorded.at, "deferred_verb_dropped", `${String(recorded.input.action)}: superseded by stop`);
        return this.store.task(task.id);
      }
      return held;
    }, `task:${input.taskId}`);
  }
}
