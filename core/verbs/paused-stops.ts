import type { z } from "zod";
import type { Run, Task } from "../../shared/contracts";
import { pausedStopWaitReason, type PausedStop, type stopThreads } from "../../shared/contracts";
import type { Engine } from "../engine";
import type { AgentObservation } from "../host/adapter";
import { digest, now } from "../store/store";
import { ProvenPreSendRefusalError } from "../recovery/task-reasons";

/**
 * The operator's stop-every-active-thread control while paused, and resuming
 * each stopped thread in place once Nucleus runs again. Same-name `Engine`
 * methods delegate here. `store`, `adapter` and `resolution` read the engine
 * per call: tests replace the adapter.
 */
export class PausedStops {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get resolution() { return this.engine.resolution; }

  /**
   * Queue #650: the operator's stop-every-active-thread control, refused unless
   * Queue is paused. It cancels every live Queue-owned agent turn — workers,
   * revisions, reviewers, executors, recovery and closeout coordinators and
   * proof-only runs — through the existing durable stop and active-turn
   * cancellation path, and records a `paused_stop` marker on each stopped run so
   * nothing treats the stop as a failure, a non-delivery, a stall or a reason to
   * start a coordinator, and no budget, retry or replacement counter moves.
   * Worktrees, branches, PRs, uncommitted work, review state and every hold are
   * kept; planner and other non-Queue threads are never enumerated. Unpause
   * resumes every marker in its own agent thread (`resumePausedStops`).
   */
  async stopActiveThreads(input: { caller?: string } = {}): Promise<z.infer<typeof stopThreads.output>> {
    if (this.engine.stopped) throw new Error("Nucleus is stopping; stop active threads applies to a running queue");
    if (this.store.getMeta("paused") !== true) throw new Error("Stop active threads applies only while the queue is paused");
    const operator = (input.caller ?? "operator (board)").slice(0, 200);
    return this.engine.control(async () => {
      const stopped: { taskId: string; runId: string | null; agentId: string; role: string }[] = [];
      const failures: string[] = [];
      const episodeAt = now();
      // One candidate per Queue-owned agent: every unreleased, unfinished run row
      // first, then the task's own initial worker. A revision run sharing the
      // retained agent therefore owns the marker, and already-marked threads are
      // idempotent retries of the same control, never stopped twice.
      const seen = new Set<string>();
      const candidates: { task: Task; run: Run | null }[] = [];
      for (const task of this.store.activeCapacityTasks()) {
        if (["done", "cancelled"].includes(task.phase)) continue;
        for (const run of this.store.runs(task.id)) {
          if (run.released || run.completion || run.status === "superseded" || !run.agentId || run.pausedStop || seen.has(run.agentId)) continue;
          seen.add(run.agentId);
          candidates.push({ task: this.store.task(task.id), run });
        }
        if (task.agentId && task.workspaceId && !task.completion && !task.pausedStop && !seen.has(task.agentId)) {
          seen.add(task.agentId);
          candidates.push({ task: this.store.task(task.id), run: null });
        }
      }
      for (const { task, run } of candidates) {
        const agentId = run?.agentId ?? task.agentId!;
        const workspaceId = run?.workspaceId ?? task.workspaceId!;
        const role = run ? run.role : "worker" as const;
        const runId = run?.id ?? task.runId ?? null;
        let observed: AgentObservation | null = null;
        try { observed = await this.engine.onTaskHost({ hostId: task.hostId }, () => this.engine.host.observe(agentId)); } catch { observed = null; }
        // Only a matching observation proves a live turn; an unreadable or
        // mismatched identity is never stopped and never marked.
        if (!observed || observed.id !== agentId || observed.workspaceId !== workspaceId) continue;
        if (!(observed.active || observed.activeTurnId || observed.permissions)) continue;
        const cancel = this.adapter.stopAgentTurn;
        if (!cancel) {
          failures.push(`Paseo active-turn cancellation is unavailable, so Nucleus cannot stop the live ${role} thread (${agentId}); retry once Paseo offers it`);
          continue;
        }
        const effectId = `ns-paused-stop-${digest(`${task.id}:${runId ?? "worker"}:${agentId}`).slice(0, 32)}`;
        const intent = { runId, role, agentId, workspaceId, operator, effectId };
        this.store.event(task.id, "paused_stop_intent", JSON.stringify(intent));
        try { await cancel.call(this.adapter, agentId); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.store.event(task.id, "paused_stop_uncertain", JSON.stringify({ ...intent, status: "uncertain", message: message.slice(0, 2000) }));
          failures.push(`Nucleus could not stop the live ${role} thread (${agentId}): ${message}; retry the same control`);
          continue;
        }
        this.store.event(task.id, "paused_stop_sent", JSON.stringify({ ...intent, status: "sent" }));
        const at = now();
        if (run) {
          // A turn that settles during its cancellation (a late callback, a
          // release) keeps its ordinary handling; nothing is marked or resumed.
          const latest = this.store.run(run.id);
          if (!latest || latest.released || latest.completion || latest.agentId !== agentId || latest.workspaceId !== workspaceId) continue;
          this.store.putRun({ ...latest, pausedStop: { at, operator, runId: latest.id, agentId, workspaceId, role: latest.role },
            active: false, lastObservedAt: at, idleSince: latest.idleSince ?? at });
        } else {
          const latest = this.store.task(task.id);
          if (latest.agentId !== agentId || latest.workspaceId !== workspaceId || latest.completion || ["done", "cancelled"].includes(latest.phase)) continue;
          this.store.update(latest.id, { pausedStop: { at, operator, runId: latest.runId ?? null, agentId, workspaceId, role: "worker" as const } }, "paused_stop", JSON.stringify({ agentId, runId: latest.runId ?? null }));
        }
        stopped.push({ taskId: task.id, runId, agentId, role });
      }
      // Each affected task names its visible paused-stop wait once, so `next`,
      // the board and task detail read the same typed record as every other wait.
      const byTask = new Map<string, string[]>();
      for (const entry of stopped) byTask.set(entry.taskId, [...(byTask.get(entry.taskId) ?? []), entry.role]);
      for (const [taskId, roles] of byTask) {
        const list = [...new Set(roles)];
        const subject = list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0];
        const reason = list.length > 1
          ? `The ${subject} threads were stopped while Nucleus was paused; Nucleus resumes them in their own threads when the queue starts`
          : pausedStopWaitReason(subject);
        this.resolution.waiting(this.store.task(taskId), reason, "paused_stop");
      }
      // Every accepted invocation of the control begins a new episode window for
      // the board's resumed count, whether or not this pass stopped a thread.
      this.store.setMeta("pausedStopEpisodeAt", episodeAt);
      if (stopped.length) this.store.advanceRevision();
      if (failures.length) throw new Error(failures.join("; "));
      return { ok: true as const, stopped };
    }, "queue:stop-threads");
  }

  /**
   * Queue #650: resume every run with an unresolved `paused_stop` marker in its
   * own agent thread. Called when the queue unpauses and by the ordinary audit
   * pass until no marker remains, so a thread the daemon closed meanwhile (whose
   * session persists) and uncertain deliveries both settle here. Oldest stop
   * first, one continuation per existing thread — never a new run, so no
   * capacity, budget, retry or replacement counter moves. A thread that cannot
   * be resumed, or whose provider failed, is replaced under the ordinary rules:
   * the worker or revision arm is the ordinary failover sweep, and a reviewer or
   * coordinator falls back to the ordinary stopped-run handling.
   */
  async resumePausedStops(): Promise<void> {
    if (this.engine.stopped || this.store.getMeta("paused") === true) return;
    const items: { taskId: string; marker: PausedStop; onTask: boolean }[] = [];
    for (const task of this.store.activeCapacityTasks()) {
      if (!task.hostId || !this.engine.withHost(task.hostId, () => this.engine.taskHostAvailable(task))) continue;
      if (["done", "cancelled"].includes(task.phase)) continue;
      if (task.pausedStop) items.push({ taskId: task.id, marker: task.pausedStop, onTask: true });
      for (const run of this.store.runs(task.id)) if (!run.released && !run.completion && run.pausedStop) items.push({ taskId: task.id, marker: run.pausedStop, onTask: false });
    }
    items.sort((a, b) => a.marker.at.localeCompare(b.marker.at) || a.taskId.localeCompare(b.taskId) || (a.marker.runId ?? "").localeCompare(b.marker.runId ?? ""));
    for (const item of items) {
      const task = this.store.task(item.taskId);
      await this.engine.withHost(task.hostId, () => this.resumeOnePausedStop(item.taskId, item.marker, item.onTask));
    }
  }

  /**
   * One thread's uncertain paused-stop delivery attempts, bounded like the
   * transient resumes. Counted by agent since the marker's stop, so the task-row
   * initial worker (whose marker names the task's run id, never the literal
   * event tag) and every run-row marker share one correct bound (review 5760041700).
   */
  private pausedStopAttempts(taskId: string, marker: PausedStop): number {
    return this.store.eventsAll(taskId).filter(event => event.kind === "paused_resume_uncertain"
      && event.at >= marker.at
      && (() => { try { return JSON.parse(event.detail).agentId === marker.agentId; } catch { return false; } })()).length;
  }

  private async resumeOnePausedStop(taskId: string, marker: PausedStop, onTask: boolean): Promise<void> {
    const task = this.store.task(taskId);
    if (task.removedAt || ["done", "cancelled"].includes(task.phase)) return;
    const at = now();
    if (onTask) {
      // The task's own initial worker thread. A binding that moved on (a new
      // dispatch, retirement, completion) makes the marker stale history.
      const latest = this.store.task(taskId);
      if (latest.agentId !== marker.agentId || latest.workspaceId !== marker.workspaceId || latest.completion) {
        this.store.update(taskId, { pausedStop: undefined }, "paused_resume_stale", JSON.stringify({ agentId: marker.agentId }));
        return;
      }
      const attempts = this.pausedStopAttempts(taskId, marker);
      if (!this.adapter.continueWorker || attempts >= 3) {
        this.dropPausedStopWithReplacement(taskId, marker, attempts >= 3
          ? "its paused-stop continuation could not be delivered after 3 attempts"
          : "no delivery channel exists for the retained worker continuation");
        return;
      }
      const text = `Nucleus paused-stop continuation for task ${taskId}, worker run ${latest.runId ?? "unknown"}, planning head ${latest.planningBase}. Nucleus was paused and the operator stopped this thread while it was mid-turn; Nucleus is running again. Pick up where you left off in this same workspace and on the task branch; report via your existing authenticated callback for this same run. Do not start a new run or change the requested head or task branch.`;
      this.store.event(taskId, "paused_resume_intent", JSON.stringify({ runId: null, agentId: marker.agentId, role: "worker", attempt: attempts + 1 }));
      try {
        await this.engine.onTaskHost(latest, () => this.adapter.continueWorker!(latest, `paused-${taskId}`, text));
      } catch (error) {
        if (error instanceof ProvenPreSendRefusalError) {
          this.dropPausedStopWithReplacement(taskId, marker, `same-thread continuation was refused before send: ${error.message}`);
          return;
        }
        const detail = error instanceof Error ? error.message : String(error);
        this.store.event(taskId, "paused_resume_uncertain", JSON.stringify({ runId: "worker", agentId: marker.agentId, role: "worker", detail: detail.slice(0, 1000), at }));
        return;
      }
      this.store.update(taskId, { pausedStop: undefined }, "paused_resume", JSON.stringify({ runId: latest.runId ?? null, agentId: marker.agentId, role: "worker", stoppedAt: marker.at }));
      this.resolution.update(this.store.task(taskId), { stop: null }, { reason: "Paused-stop continuation thread running" }, "paused_resume_running");
      return;
    }
    // A run-row marker always names its run; the type cannot see it, so guard once.
    const markerRunId = marker.runId;
    if (markerRunId === null) return;
    const run = this.store.run(markerRunId);
    // A run that settled or was superseded while stopped keeps its ordinary
    // handling; the marker only ever resumes live retained work.
    if (!run || run.released || run.completion || run.agentId !== marker.agentId || run.workspaceId !== marker.workspaceId) {
      if (run && !run.released) this.store.putRun({ ...run, pausedStop: undefined });
      this.store.event(taskId, "paused_resume_stale", JSON.stringify({ runId: markerRunId, agentId: marker.agentId, role: marker.role }));
      return;
    }
    const attempts = this.pausedStopAttempts(taskId, marker);
    if (!this.adapter.continueRun || attempts >= 3) {
      this.dropPausedStopCoordinatorRun(taskId, run, marker, attempts >= 3 ? "its paused-stop continuation could not be delivered after 3 attempts" : "no delivery channel exists for the retained continuation");
      return;
    }
    const text = `Nucleus paused-stop continuation for task ${taskId}, run ${run.id}, exact head ${run.head}. Nucleus was paused and the operator stopped this thread while it was mid-turn; Nucleus is running again. Continue where you left off; report via your existing authenticated callback for this same run. Do not start a new run or change the requested head.`;
    this.store.event(taskId, "paused_resume_intent", JSON.stringify({ runId: run.id, agentId: marker.agentId, role: run.role, attempt: attempts + 1 }));
    try {
      await this.engine.onTaskHost(run, () => this.adapter.continueRun!(run, `ns-paused-resume-${run.id}`, text));
    } catch (error) {
      if (error instanceof ProvenPreSendRefusalError) {
        this.dropPausedStopCoordinatorRun(taskId, run, marker, `same-thread continuation was refused before send: ${error.message}`);
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.store.event(taskId, "paused_resume_uncertain", JSON.stringify({ runId: run.id, agentId: marker.agentId, role: run.role, detail: detail.slice(0, 1000), at }));
      return;
    }
    const latest = this.store.run(run.id);
    if (latest && !latest.released && !latest.completion) this.store.putRun({ ...latest, pausedStop: undefined });
    this.store.event(taskId, "paused_resume", JSON.stringify({ runId: run.id, agentId: marker.agentId, role: run.role, stoppedAt: marker.at }));
    this.resolution.update(this.store.task(taskId), { stop: null }, { reason: `Paused-stop continuation thread running (${run.role})` }, "paused_resume_running");
  }

  /**
   * The retained worker thread cannot be resumed: clear its marker and arm the
   * ordinary failover sweep, whose one-thread rules (#577/#605/#610) own the
   * replacement. No replacement counter moves here.
   */
  private dropPausedStopWithReplacement(taskId: string, marker: PausedStop, reason: string): void {
    const detail = `agent_errored: paused-stop resume was ${reason}`.slice(0, 2000);
    this.store.transaction(() => {
      const latest = this.store.task(taskId);
      if (latest.pausedStop?.at === marker.at) this.store.update(taskId, { pausedStop: undefined, failoverReason: detail }, "paused_resume_replacement_armed", detail);
      else this.store.event(taskId, "paused_resume_refused", JSON.stringify({ runId: null, agentId: marker.agentId, role: "worker", reason: detail.slice(0, 1200) }));
    });
  }

  /**
   * A retained reviewer, executor or coordinator run cannot be resumed: clear
   * its marker so the ordinary stopped-run handling (callback reminder,
   * incident, Spec 058 fresh-reviewer replacement) owns the fault.
   */
  private dropPausedStopCoordinatorRun(taskId: string, run: Run, marker: PausedStop, reason: string): void {
    const detail = `paused-stop resume was ${reason}`.slice(0, 2000);
    this.store.transaction(() => {
      const latest = this.store.run(run.id);
      if (latest && !latest.released && latest.pausedStop?.at === marker.at) this.store.putRun({ ...latest, pausedStop: undefined });
      const task = this.store.task(taskId);
      if (task.pausedStop?.at === marker.at) this.store.update(taskId, { pausedStop: undefined });
      this.store.event(taskId, "paused_resume_refused", JSON.stringify({ runId: run.id, agentId: marker.agentId, role: marker.role, reason: detail.slice(0, 1200) }));
    });
  }
}
