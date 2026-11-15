import type { Task, TaskControlInput } from "../../shared/contracts";
import { taskControlInputSchema } from "../../shared/contracts";
import { dispatchBlocked } from "../dispatch/capacity";
import type { Engine } from "../engine";
import { now } from "../store/store";

/** The exact run (and checkpoint) a recorded verb was for. */
export type DeferredVerbTarget = { runId: string; checkpointOrdinal?: number; head?: string } | null;

/**
 * Round 4: an owner verb whose effect is an immediate delivery applies now, and
 * what it would start waits for Queue to be unpaused and the task unheld. This
 * module owns the record, its target, its replay and its one refusal.
 */
export class DeferredOwnerVerbs {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }

  /** Record an owner verb to apply once the wait clears, bound to the run (and checkpoint) it was for. */
  deferOwnerVerb(task: Task, input: TaskControlInput, why: "paused" | "held", target: DeferredVerbTarget): Task {
    const { version: _version, ...rest } = input;
    return this.store.update(task.id, {
      reason: `Owner ${input.action} recorded; it is delivered once Nucleus is ${why === "paused" ? "unpaused" : "released"}`,
      resolution: { ...task.resolution, deferredVerb: { input: rest as Record<string, unknown>, at: now(), why, target } },
    }, "owner_verb_deferred", JSON.stringify({ action: input.action, role: input.role ?? null, why, target }));
  }

  /** Drop the recorded verb if it is still the one read (`at`), with one event. */
  dropDeferredVerb(taskId: string, at: string, kind: string, detail: string): void {
    this.store.transaction(() => {
      const current = this.store.task(taskId);
      if (current.resolution.deferredVerb?.at !== at) return;
      this.store.update(taskId, { resolution: { ...current.resolution, deferredVerb: null } }, kind, detail.slice(0, 2000));
    });
  }

  /** Why a recorded verb's target no longer holds, or null. */
  private targetChanged(task: Task, target: DeferredVerbTarget): string | null {
    if (!target) return null;
    if (task.runId === target.runId && task.agentId && !this.store.run(target.runId)) return null;
    if (task.resolution.currentRunId !== target.runId) return `its run ${target.runId} is no longer current`;
    const run = this.store.run(target.runId);
    if (!run || run.released) return `its run ${target.runId} was released`;
    if (target.checkpointOrdinal !== undefined && run.reviewCheckpoints?.at(-1)?.ordinal !== target.checkpointOrdinal) return `checkpoint ${target.checkpointOrdinal} is no longer the latest`;
    if (target.head !== undefined && run.head !== target.head) return `its head ${target.head} changed`;
    return null;
  }

  /** A deferred restart can supersede only the owner stop that preceded its recorded instruction. */
  deferredRestartSupersedesOwnerStop(task: Task): boolean {
    const deferred = task.resolution.deferredVerb;
    const targetRunId = deferred?.target?.runId;
    if (!deferred || deferred.input.action !== "restart" || !targetRunId || !this.engine.ownerStopHold(task)) return false;
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
      const changed = this.targetChanged(task, deferred.target ?? null);
      if (changed) { this.dropDeferredVerb(id, deferred.at, "deferred_verb_refused", `${String(deferred.input.action)}: ${changed}`); continue; }
      this.store.event(id, "owner_verb_resumed", JSON.stringify({ action: deferred.input.action, recordedAt: deferred.at }));
      try {
        await this.engine.replayingDeferredVerb.run(true, () =>
          this.engine.performTaskControl(taskControlInputSchema.parse({ ...deferred.input, version: this.store.task(id).version }) as TaskControlInput));
        this.dropDeferredVerb(id, deferred.at, "owner_verb_applied", String(deferred.input.action));
      } catch (error) {
        this.dropDeferredVerb(id, deferred.at, "deferred_verb_refused", `${String(deferred.input.action)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
