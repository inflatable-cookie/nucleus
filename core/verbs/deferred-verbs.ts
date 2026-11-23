import { endsStopOnReason } from "../../shared/task-stop";
import type { Task, TaskControlInput } from "../../shared/contracts";
import {
  isDispositionComplete,
  taskControlInputSchema,
} from "../../shared/contracts";
import { ProvenPreSendRefusalError } from "../host/errors";
import { dispatchBlocked, slotRequestFenced } from "../dispatch/capacity";
import type { Engine } from "../engine";
import { TASK_PROGRESSING_REASON } from "../../shared/task-detail-summary";
import { LANE_PRIORITY_TASK } from "../scheduling/lane-priorities";
import { now, type Store } from "../store/store";

/** The exact run (and checkpoint) a recorded verb was for. */
export type DeferredVerbTarget = {
  runId: string;
  checkpointOrdinal?: number;
  head?: string;
} | null;

/** The exact reason the deferred-verb writer owns. */
const deferredVerbReason = (action: unknown, why: string) =>
  `Owner ${String(action)} recorded; it is delivered once Nucleus is ${why === "paused" ? "unpaused" : "released"}`;

/** Settle a stop left behind by a release on an earlier service build. */
function settleDroppedDeferredVerbStop(store: Store, taskId: string): void {
  const task = store.task(taskId);
  if (task.resolution.deferredVerb) return;
  const stop = task.resolution.stop;
  if (stop?.fact?.code !== "deferred_verb") return;
  const events = store.eventsAll(taskId);
  const deferred = events.findLast(
    (event) => event.kind === "owner_verb_deferred",
  );
  if (!deferred) return;
  let recorded: { action?: string; why?: string };
  try {
    recorded = JSON.parse(deferred.detail);
  } catch {
    return;
  }
  if (
    !recorded.action ||
    !recorded.why ||
    stop.fact.subject !== recorded.action
  )
    return;
  const settled = events.find(
    (event) =>
      event.id > deferred.id &&
      event.at >= stop.since &&
      ((event.kind === "deferred_verb_refused" &&
        event.detail.startsWith(`${recorded.action}: `)) ||
        (event.kind === "owner_verb_applied" &&
          event.detail === recorded.action)),
  );
  if (!settled) return;
  store.update(
    task.id,
    {
      reason:
        settled.kind === "deferred_verb_refused"
          ? `Recorded owner action is no longer applicable: ${settled.detail.slice(0, 1200)}`
          : TASK_PROGRESSING_REASON,
      resolution: { ...task.resolution, stop: null },
    },
    "deferred_verb_stop_cleared",
    String(settled.id),
  );
}

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
        reason: deferredVerbReason(input.action, why),
        resolution: {
          ...task.resolution,
          ...endsStopOnReason(task, deferredVerbReason(input.action, why)),
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
      const deferred = current.resolution.deferredVerb;
      const marker = deferred.input.__workerAsk as
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
      const oldStop = current.resolution.stop;
      const ownsStop =
        oldStop?.fact?.code === "deferred_verb" &&
        oldStop.fact.subject === deferred.input.action;
      const reason =
        current.reasonFact?.code === "deferred_verb" &&
        current.reasonFact.subject === deferred.input.action
          ? (!ownsStop && oldStop?.detail) ||
            (kind === "deferred_verb_refused"
              ? `Recorded owner action is no longer applicable: ${detail.slice(0, 1200)}`
              : TASK_PROGRESSING_REASON)
          : current.reason;
      this.store.update(
        taskId,
        {
          reason,
          resolution: {
            ...current.resolution,
            deferredVerb: null,
            ...(ownsStop ? { stop: null } : {}),
          },
        },
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
    if (["done", "cancelled"].includes(task.phase))
      return `the task is ${task.phase}`;
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
    if (
      target.head !== undefined &&
      (run.head !== target.head || task.prHead !== target.head)
    )
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

  /** A legacy worker_creation deferred verb is dropped now that uncertain creations use run.start. */
  private async applyWorkerCreationRestart(taskId: string) {
    const task = this.store.task(taskId);
    const deferred = task.resolution.deferredVerb;
    if (!deferred || deferred.why !== "worker_creation") return;
    this.dropDeferredVerb(
      taskId,
      deferred.at,
      "deferred_verb_dropped",
      "Use run.start worker fresh or run.start worker retained to resolve uncertain worker creations explicitly",
    );
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
          `SELECT id FROM tasks WHERE json_type(data,'$.resolution.deferredVerb')='object'
            OR json_extract(data,'$.resolution.stop.fact.code')='deferred_verb'
            OR (json_type(data,'$.resolution.stop.fact') IS NULL AND json_type(data,'$.resolution.stop')='object')`,
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
      if (task.hostId !== scopedHost || task.removedAt) continue;
      const deferred = task.resolution.deferredVerb;
      if (deferred?.why === "worker_creation") {
        await this.engine.control(
          () => this.applyWorkerCreationRestart(id),
          `task:${id}`,
        );
        continue;
      }
      if (!deferred) {
        await this.engine.scheduleLane(
          `task:${id}`,
          LANE_PRIORITY_TASK,
          async () => settleDroppedDeferredVerbStop(this.store, id),
        );
        continue;
      }
      if (
        !this.engine.taskHostAvailable(task) ||
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
