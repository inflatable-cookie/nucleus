import type { Task, TaskControlInput } from "../../shared/contracts";
import {
  isDispositionComplete,
  taskControlInputSchema,
} from "../../shared/contracts";
import {
  deferredWorkerCreationRestart,
  workerCreationRestartDelivery,
} from "../recovery/absent-creation/stale-worker";
import { timelineMessage } from "../recovery/effect-reconcile";
import { unsettledControlRefusal } from "../recovery/recovery-effects";
import { ProvenPreSendRefusalError } from "../host/errors";
import { dispatchBlocked, slotRequestFenced } from "../dispatch/capacity";
import type { Engine } from "../engine";
import { now } from "../store/store";

/** The exact run (and checkpoint) a recorded verb was for. */
export type DeferredVerbTarget = {
  runId: string;
  checkpointOrdinal?: number;
  head?: string;
} | null;

/**
 * Round 4: an owner verb whose effect is an immediate delivery applies now, and
 * what it would start waits for Queue to be unpaused and the task unheld. This
 * module owns the record, its target, its replay and its one refusal.
 */
export class DeferredOwnerVerbs {
  constructor(readonly engine: Engine) {}
  get store() {
    return this.engine.store;
  }
  private readonly applying = new Set<string>();

  /** Record an owner verb to apply once the wait clears, bound to the run (and checkpoint) it was for. */
  deferOwnerVerb(
    task: Task,
    input: TaskControlInput,
    why: "paused" | "held",
    target: DeferredVerbTarget,
  ): Task {
    const { version: _version, ...rest } = input;
    return this.store.update(
      task.id,
      {
        reason: `Owner ${input.action} recorded; it is delivered once Nucleus is ${why === "paused" ? "unpaused" : "released"}`,
        resolution: {
          ...task.resolution,
          deferredVerb: {
            input: rest as Record<string, unknown>,
            at: now(),
            why,
            target,
          },
        },
      },
      "owner_verb_deferred",
      JSON.stringify({
        action: input.action,
        role: input.role ?? null,
        why,
        target,
      }),
    );
  }

  /** Drop the recorded verb if it is still the one read (`at`), with one event. */
  dropDeferredVerb(
    taskId: string,
    at: string,
    kind: string,
    detail: string,
  ): void {
    let refusedEscalation: string | undefined;
    this.store.transaction(() => {
      const current = this.store.task(taskId);
      if (current.resolution.deferredVerb?.at !== at) return;
      const marker = current.resolution.deferredVerb.input.__workerAsk as
        | { escalationId?: string; questionId?: string }
        | undefined;
      if (
        marker?.escalationId &&
        marker.questionId &&
        (kind === "owner_verb_applied" || kind === "deferred_verb_refused")
      ) {
        const key = `delegation:${marker.questionId}`;
        const events = this.store.eventsAll(key);
        const answer = events.findLast(
          (event) => event.kind === "delegated_answer",
        );
        if (
          answer &&
          !events.some(
            (event) =>
              event.id > answer.id &&
              (event.kind === "delegated_command_applied" ||
                event.kind === "delegated_command_refused"),
          )
        )
          this.store.event(
            key,
            kind === "owner_verb_applied"
              ? "delegated_command_applied"
              : "delegated_command_refused",
            `${marker.escalationId}: ${kind === "owner_verb_applied" ? `applied after answer event ${answer.id}` : detail}`.slice(
              0,
              4000,
            ),
          );
      }
      if (kind === "deferred_verb_refused" && marker?.escalationId) {
        refusedEscalation = marker.escalationId;
        this.store.event(
          taskId,
          "planner_escalation_refused",
          `${marker.escalationId}: ${detail}`.slice(0, 4000),
        );
        this.store.event(
          taskId,
          "planner_escalation_answer_refused",
          `${marker.escalationId}: ${detail}`.slice(0, 4000),
        );
      }
      this.store.update(
        taskId,
        { resolution: { ...current.resolution, deferredVerb: null } },
        kind,
        detail.slice(0, 2000),
      );
    });
    if (refusedEscalation)
      this.engine.resolution.waiting(
        this.store.task(taskId),
        `Escalation ${refusedEscalation} is unresolved: ${detail}`,
        "escalated",
      );
  }

  /** Why a recorded verb's target no longer holds, or null. */
  private targetChanged(task: Task, target: DeferredVerbTarget): string | null {
    if (!target) return null;
    if (
      task.runId === target.runId &&
      task.agentId &&
      !this.store.run(target.runId)
    )
      return null;
    if (task.resolution.currentRunId !== target.runId)
      return `its run ${target.runId} is no longer current`;
    const run = this.store.run(target.runId);
    if (!run || run.released) return `its run ${target.runId} was released`;
    if (
      target.checkpointOrdinal !== undefined &&
      run.reviewCheckpoints?.at(-1)?.ordinal !== target.checkpointOrdinal
    )
      return `checkpoint ${target.checkpointOrdinal} is no longer the latest`;
    if (target.head !== undefined && run.head !== target.head)
      return `its head ${target.head} changed`;
    return null;
  }

  /** A deferred restart can supersede only the owner stop that preceded its recorded instruction. */
  deferredRestartSupersedesOwnerStop(task: Task): boolean {
    const deferred = task.resolution.deferredVerb;
    const targetRunId = deferred?.target?.runId;
    if (
      !deferred ||
      deferred.input.action !== "restart" ||
      !targetRunId ||
      !this.engine.ownerStopHold(task)
    )
      return false;
    const events = this.store.eventsAll(task.id);
    const deferredEvent = events.findLast((event) => {
      if (event.kind !== "owner_verb_deferred") return false;
      try {
        const detail = JSON.parse(event.detail) as {
          action?: unknown;
          target?: { runId?: unknown } | null;
        };
        return (
          detail.action === "restart" && detail.target?.runId === targetRunId
        );
      } catch {
        return false;
      }
    });
    const stopEvent = events.findLast((event) => {
      if (event.kind !== "owner_stopped") return false;
      try {
        const detail = JSON.parse(event.detail) as { runIds?: unknown };
        return (
          Array.isArray(detail.runIds) && detail.runIds.includes(targetRunId)
        );
      } catch {
        return false;
      }
    });
    return Boolean(
      deferredEvent && stopEvent && stopEvent.id < deferredEvent.id,
    );
  }

  /** A creation restart either transfers to a fresh launch or delivers on the original binding. */
  private async applyWorkerCreationRestart(taskId: string) {
    let task = this.store.task(taskId);
    const deferred = deferredWorkerCreationRestart(task);
    if (!deferred) return;
    const target = deferred.target;
    const finish = (kind: string, detail: string) =>
      this.dropDeferredVerb(taskId, deferred.at, kind, detail);
    if (
      !target ||
      target.runId !== task.runId ||
      target.hostId !== task.hostId ||
      target.workspaceId !== task.workspaceId ||
      task.removedAt ||
      ["done", "cancelled"].includes(task.phase) ||
      isDispositionComplete(task) ||
      task.completion ||
      task.resolution.mergedCommit
    ) {
      finish(
        "deferred_verb_dropped",
        "The original worker creation no longer owns this restart instruction",
      );
      return;
    }
    const agentId = task.agentId;
    if (!agentId) return; // Exact creation settlement still owns the discovery.
    const {
      messageId,
      state,
      agentId: sentTo,
    } = workerCreationRestartDelivery(this.store, task, deferred.at);
    if (sentTo && sentTo !== task.agentId) {
      finish(
        "deferred_verb_dropped",
        "The worker binding changed after the restart delivery intent",
      );
      return;
    }
    const blocked = (current: Task) =>
      this.engine.stopped ||
      this.store.getMeta("paused") ||
      slotRequestFenced(current) ||
      Boolean(
        current.prerequisiteWait && !current.prerequisiteWait.releasedAt,
      ) ||
      Boolean(current.resolution.currentRunId) ||
      this.store.runs(taskId).some((run) => !run.released) ||
      Boolean(unsettledControlRefusal(this.store, current));
    const unchanged = () => this.store.task(taskId).version === task.version;
    if (state === "sent") {
      finish(
        "owner_verb_applied",
        "The retained worker received its restart instruction",
      );
      return;
    }
    if (state === "ready") {
      const notificationUnavailable = !this.engine.adapter.notify || undefined;
      if (notificationUnavailable !== deferred.notificationUnavailable)
        task = this.store.update(
          taskId,
          {
            resolution: {
              ...task.resolution,
              deferredVerb: { ...deferred, notificationUnavailable },
            },
          },
          "worker_restart_notification_capability",
          notificationUnavailable ? "Unavailable" : "Restored",
        );
      if (notificationUnavailable || blocked(task)) return;
    }

    const binding = JSON.stringify({
      runId: task.runId,
      agentId,
      workspaceId: task.workspaceId,
      messageId,
    });
    const markSent = () =>
      this.store.transaction(() => {
        this.store.event(taskId, "owner_restart_instruction_sent", binding);
        const current = this.store.task(taskId);
        if (current.resolution.deferredVerb?.at === deferred.at)
          this.store.update(
            taskId,
            { resolution: { ...current.resolution, deferredVerb: null } },
            "owner_verb_applied",
            "The retained worker received its restart instruction",
          );
      });
    try {
      const observed = await this.engine.host.observe(agentId);
      if (
        observed.id !== agentId ||
        observed.workspaceId !== task.workspaceId ||
        !unchanged()
      )
        return;
      if (state === "uncertain") {
        const page = await this.engine.host.agentTimelinePage(agentId, 100);
        if (unchanged() && timelineMessage(page, messageId) === "present")
          markSent();
        return;
      }
      if (
        observed.active ||
        observed.activeTurnId ||
        observed.permissions ||
        !["idle", "error"].includes(observed.status) ||
        blocked(this.store.task(taskId))
      )
        return;
    } catch {
      return; // An unavailable read leaves the recorded instruction owned.
    }

    const adapter = this.engine.adapter;
    const notify = adapter.notify;
    if (!notify) return;
    this.store.event(taskId, "owner_restart_instruction_intent", binding);
    try {
      await notify.call(
        adapter,
        agentId,
        messageId,
        `Owner restart instruction for the existing task run ${task.runId}: ${String(deferred.input.instruction)}`,
      );
    } catch (error) {
      if (error instanceof ProvenPreSendRefusalError)
        finish("deferred_verb_refused", error.message);
      return; // A lost reply owns its original intent until the timeline answers it.
    }
    markSent();
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
    const ids = (
      this.store.db
        .prepare(
          "SELECT id FROM tasks WHERE json_extract(data,'$.resolution.deferredVerb') IS NOT NULL",
        )
        .all() as Array<{ id: string }>
    ).map((row) => row.id);
    if (!scopedHost) {
      for (const host of new Set(
        ids.flatMap((id) => {
          const host = this.store.task(id).hostId;
          return host ? [host] : [];
        }),
      ))
        await this.engine.withHost(host, () =>
          this.applyDeferredOwnerVerbs(host),
        );
      return;
    }
    for (const id of ids) {
      const task = this.store.task(id);
      if (task.hostId !== scopedHost) continue;
      if (!this.engine.taskHostAvailable(task)) continue;
      const deferred = task.resolution.deferredVerb;
      if (deferred?.why === "worker_creation") {
        await this.engine.control(
          () => this.applyWorkerCreationRestart(id),
          `task:${id}`,
        );
        continue;
      }
      if (
        !deferred ||
        task.removedAt ||
        (dispatchBlocked(task) &&
          !this.deferredRestartSupersedesOwnerStop(task))
      )
        continue;
      // Older versions recorded checkpoint continuations during pause. Replay
      // only that bound delivery while paused; new starts remain deferred.
      if (this.store.getMeta("paused")) {
        const input = deferred.input;
        const target = deferred.target;
        const isContinuation =
          target?.checkpointOrdinal != null &&
          target.runId === task.resolution.currentRunId &&
          input.fresh !== true &&
          ((input.action === "restart" && input.role === "reviewer") ||
            (input.action === "move" && input.to === "review"));
        if (!isContinuation) continue;
      }
      if (this.applying.has(id)) continue;
      this.applying.add(id);
      try {
        const { __workerAsk, ...control } = deferred.input;
        if (__workerAsk) {
          const marker = __workerAsk as {
            runId?: string;
            agentId?: string;
            workspaceId?: string;
          };
          if (
            !marker.runId ||
            !marker.agentId ||
            !marker.workspaceId ||
            task.agentId !== marker.agentId ||
            task.workspaceId !== marker.workspaceId ||
            (task.runId !== marker.runId &&
              task.resolution.currentRunId !== marker.runId)
          ) {
            this.dropDeferredVerb(
              id,
              deferred.at,
              "deferred_verb_refused",
              "The retained worker identity changed before its recorded direction",
            );
            continue;
          }
          let observed;
          try {
            observed = await this.engine.host.observe(marker.agentId);
          } catch {
            continue;
          }
          if (
            observed.id !== marker.agentId ||
            observed.workspaceId !== marker.workspaceId
          )
            continue;
          if (
            observed.active ||
            observed.activeTurnId ||
            observed.permissions ||
            !["idle", "error"].includes(observed.status)
          )
            continue;
          const latest = this.store.task(id);
          if (latest.resolution.deferredVerb?.at !== deferred.at) continue;
          if (
            latest.agentId !== marker.agentId ||
            latest.workspaceId !== marker.workspaceId ||
            (latest.runId !== marker.runId &&
              latest.resolution.currentRunId !== marker.runId)
          ) {
            this.dropDeferredVerb(
              id,
              deferred.at,
              "deferred_verb_refused",
              "The retained worker identity changed during observation",
            );
            continue;
          }
        }
        const changed = this.targetChanged(
          this.store.task(id),
          deferred.target ?? null,
        );
        if (changed) {
          this.dropDeferredVerb(
            id,
            deferred.at,
            "deferred_verb_refused",
            `${String(control.action)}: ${changed}`,
          );
          continue;
        }
        this.store.event(
          id,
          "owner_verb_resumed",
          JSON.stringify({ action: control.action, recordedAt: deferred.at }),
        );
        try {
          await this.engine.replayingDeferredVerb.run(true, () =>
            this.engine.performTaskControl(
              taskControlInputSchema.parse({
                ...control,
                version: this.store.task(id).version,
              }) as TaskControlInput,
            ),
          );
          const marker = __workerAsk as
            | { escalationId?: string; who?: string; answer?: string }
            | undefined;
          if (marker?.escalationId) {
            this.store.event(
              id,
              "planner_escalation_answered",
              `${marker.escalationId}: answered by ${marker.who ?? "planner"}: ${marker.answer ?? ""}`.slice(
                0,
                4000,
              ),
            );
            this.store.event(
              id,
              "planner_escalation_applied",
              `${marker.escalationId}: deferred direction applied`,
            );
          }
          this.dropDeferredVerb(
            id,
            deferred.at,
            "owner_verb_applied",
            String(control.action),
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          // The worker can start another turn between the two observations. This
          // particular refusal is before continuation delivery; retain the intent.
          if (
            __workerAsk &&
            /The retained worker is (?:not positively idle|no longer positively idle)/.test(
              detail,
            )
          )
            continue;
          this.dropDeferredVerb(
            id,
            deferred.at,
            "deferred_verb_refused",
            `${String(control.action)}: ${detail}`,
          );
        }
      } finally {
        this.applying.delete(id);
      }
    }
  }
}
