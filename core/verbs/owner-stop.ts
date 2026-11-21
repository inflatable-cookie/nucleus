import { REMOVED_TASK_REFUSAL, stopStateRefusal } from './control-refusals';
import type {
  OwnerStopCancellation,
  OwnerStopRecord,
  Run,
  Task,
  TaskControlInput,
} from "../../shared/contracts";
import { holdsOf, isDispositionActive } from "../../shared/contracts";
import { operationIsSettled } from "../../shared/operations";
import { HOST_KIND_LABELS, hostKindOf } from "../../shared/host-kind";
import { TaskChangedRefusal } from "../../shared/task-version";
import { dispatchBlocked, DISPATCH_HELD_REASON } from "../dispatch/capacity";
import type { Engine } from "../engine";
import { holdPatch, OPERATOR_HOLD_OWNER, OWNER_STOP_HOLD_PREFIX, releasePatch } from "../merge/merge-hold";
import { ownerControlEventDetail, type RouteRole } from "./owner-verbs";
import { ownerStoppedRunIds } from "./owner-facts";
import { DurableFenceRefusal, matchingInactiveParticipant } from "../intake/run-settlement";
import { observationAdvanceSince, runsUnchangedSince } from "../recovery/observation-advance";
import type { Adapter } from "../host/adapter";
import { digest, now } from "../store/store";

export function ownerStopPendingRefusal(stop: OwnerStopRecord): string {
  const unresolved = stop.cancellations.filter(
    (entry) => entry.status !== "sent" && entry.status !== "settled",
  );
  const summary = unresolved.length
    ? unresolved
        .map((entry) => `${entry.runId} (${entry.note || entry.status})`)
        .join(", ")
    : "pending participants";
  return `An accepted owner stop still awaits cancellation confirmation for ${summary}; let observation settle it first`;
}

/** Whether executing `stop` on this task requires host observation or turn cancellation. */
export function stopControlNeedsHost(
  task: Task,
  runs: readonly Run[],
  input: Pick<TaskControlInput, "role">,
): boolean {
  if (task.resolution.ownerStop) return true;
  const role = input.role as RouteRole | undefined;
  const roleOf = (run: Run): RouteRole =>
    run.role === "reviewer"
      ? "reviewer"
      : run.role === "revision"
        ? "worker"
        : "coordinator";
  const hasSubjectRun = runs.some(
    (run) =>
      !run.released &&
      run.role !== "executor" &&
      (role === undefined || roleOf(run) === role),
  );
  if (hasSubjectRun) return true;
  return Boolean(
    (role === undefined || role === "worker") &&
      task.agentId &&
      task.workspaceId &&
      !runs.some((run) => !run.released && run.agentId === task.agentId),
  );
}

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
    if (
      dispatchBlocked(task) &&
      !(!task.resolution.ownerStop && this.ownerStopHold(task) && (ownerStopYields || this.engine.isOwnerCall()))
    )
      return "held";
    return null;
  }

  /** Round 4: the owner's next restart or move supersedes their own stop. Returns whether a hold was released. */
  releaseOwnerStopHold(taskId: string, allowDeferredReplay = false): boolean {
    if (!this.engine.isOwnerCall() && !allowDeferredReplay) return false;
    const task = this.store.task(taskId);
    if (task.resolution.ownerStop) return false;
    if (!this.ownerStopHold(task)) return false;
    this.store.update(task.id, releasePatch(task, "dispatch"), "release", "Owner stop released by the owner's next verb");
    return true;
  }

  private mergeNoteFor(task: Task): {
    mergeRequested: boolean;
    mergeHead: string | null;
    mergeNote: string;
  } {
    const mergeRequested = Boolean(task.resolution.mergeIntent && !task.resolution.mergedCommit);
    const mergeHead = task.resolution.mergeHead ?? task.prHead ?? null;
    const mergeNote = mergeRequested
      ? ` The merge was already requested for ${mergeHead ?? "the recorded head"} before this stop, so it may still land; Nucleus cannot cancel a request it already sent`
      : "";
    return { mergeRequested, mergeHead, mergeNote };
  }

  private holdWaitDetail(
    task: Task,
    issues: string[],
  ): string {
    const { mergeNote } = this.mergeNoteFor(task);
    const issueText = issues.filter(Boolean).join("; ");
    return `${DISPATCH_HELD_REASON}${mergeNote}${issueText ? ` Remaining activity needs attention: ${issueText}` : ""}`;
  }

  private commitOperationSuccessInTx(operationId: string | null | undefined, task: Task, settleState: boolean): void {
    if (!operationId) return;
    const op = this.store.operation(operationId);
    if (!op) return;
    if (op.state === "needs_attention") {
      if (settleState && !op.settlement) {
        const record = {
          id: op.id,
          inputHash: op.inputHash,
          attempt: op.attempts,
          intentAt: op.effect?.intentAt ?? null,
          evidence: `owner stop ${op.id} settled on participant observation`,
        };
        this.store.putOperation({
          ...op,
          settlement: {
            ...record,
            kind: "superseded",
          },
        });
        this.store.event(task.id, "operation_superseded", JSON.stringify(record));
      }
      return;
    }
    if (operationIsSettled(op.state)) return;
    const result = {
      taskId: task.id,
      number: task.number,
      taskVersion: task.version,
      phase: task.phase,
      reference: task.reference,
    };
    this.store.putOperation({
      ...op,
      taskId: op.taskId ?? task.id,
      state: settleState ? "succeeded" : op.state,
      settledAt: settleState ? now() : op.settledAt,
      diagnostic: settleState ? "" : op.diagnostic,
      result,
      effect: op.effect
        ? {
            ...op.effect,
            status: "reconciled",
            result: task.id,
            resultAt: now(),
          }
        : null,
    });
  }

  private recordAuditForObservedSettle(task: Task, stop: OwnerStopRecord, phaseBefore: Task["phase"]): void {
    if (!stop.operationId) return;
    const opKey = `operation:${stop.operationId}`;
    try {
      this.store.event(
        task.id,
        "owner_control",
        ownerControlEventDetail(
          task,
          { action: "stop", taskId: task.id, version: stop.taskVersion, reason: stop.reason, role: stop.role ?? undefined, caller: stop.caller ?? undefined },
          phaseBefore,
          task.phase,
        ),
      );
      this.store.event(task.id, "operator_control", "stop");
    } catch {
      /* audit trail write failure must not undo settled state */
    }
    try {
      this.store.recordVerbOutcome(
        task.id,
        "stop",
        "applied",
        "owner",
        { ...(stop.role ? { role: stop.role } : {}), caller: stop.caller ?? null },
        opKey,
      );
    } catch {
      /* outcome write failure must not undo settled state */
    }
  }

  private async cancelParticipantBoundary(
    taskId: string,
    cancellation: OwnerStopCancellation,
  ): Promise<void> {
    // Revalidate inside the transaction right before marking the send boundary.
    let shouldSend = true;
    this.store.transaction(() => {
      const current = this.store.task(taskId);
      const stop = current.resolution.ownerStop;
      if (!stop) {
        shouldSend = false;
        return;
      }
      const entry = stop.cancellations.find((c) => c.effectId === cancellation.effectId);
      if (!entry || entry.status === "sent" || entry.status === "settled" || entry.boundaryStartedAt !== null) {
        shouldSend = false;
        return;
      }
      const terminalOrDisposed =
        Boolean(current.removedAt) ||
        ["done", "cancelled"].includes(current.phase) ||
        Boolean(current.resolution.mergedCommit) ||
        isDispositionActive(current);
      if (terminalOrDisposed) {
        const updated = stop.cancellations.map((c) =>
          c.effectId === cancellation.effectId
            ? {
                ...c,
                status: "settled" as const,
                settledKind: "task_disposed" as const,
                note: "Task reached terminal or disposed state before cancellation boundary",
              }
            : c,
        );
        this.store.update(
          taskId,
          { resolution: { ...current.resolution, ownerStop: { ...stop, cancellations: updated } } },
          "owner_stop_progress",
          `Settled pending stop on ${cancellation.runId} after task transition`,
        );
        shouldSend = false;
        return;
      }
      const runRows = this.store.runs(taskId);
      const stillBound = cancellation.isInitialWorker
        ? current.agentId === cancellation.agentId && current.workspaceId === cancellation.workspaceId
        : runRows.some(
            (r) =>
              r.id === cancellation.runId &&
              !r.released &&
              !r.completion &&
              r.agentId === cancellation.agentId &&
              r.workspaceId === cancellation.workspaceId,
          );
      if (!stillBound) {
        const updated = stop.cancellations.map((c) =>
          c.effectId === cancellation.effectId
            ? {
                ...c,
                status: "settled" as const,
                settledKind: "observed_inactive" as const,
                note: "Run binding released or changed before cancellation boundary",
              }
            : c,
        );
        this.store.update(
          taskId,
          { resolution: { ...current.resolution, ownerStop: { ...stop, cancellations: updated } } },
          "owner_stop_progress",
          `Settled pending stop on ${cancellation.runId} after binding release`,
        );
        shouldSend = false;
        return;
      }
      if (!this.adapter.stopAgentTurn) {
        const host = HOST_KIND_LABELS[hostKindOf(current.hostId)];
        const msg = `${host} active-turn cancellation is unavailable`;
        const updated = stop.cancellations.map((c) =>
          c.effectId === cancellation.effectId
            ? { ...c, status: "uncertain" as const, note: msg }
            : c,
        );
        this.store.update(
          taskId,
          { resolution: { ...current.resolution, ownerStop: { ...stop, cancellations: updated } } },
          "owner_stop_uncertain_recorded",
          msg,
        );
        shouldSend = false;
        return;
      }
      const startedAt = now();
      const updated = stop.cancellations.map((c) =>
        c.effectId === cancellation.effectId
          ? { ...c, boundaryStartedAt: startedAt }
          : c,
      );
      this.store.update(
        taskId,
        { resolution: { ...current.resolution, ownerStop: { ...stop, cancellations: updated } } },
        "owner_stop_boundary",
        `Crossing cancellation boundary for ${cancellation.runId}`,
      );
      if (stop.operationId) {
        const op = this.store.operation(stop.operationId);
        if (op && !op.preSendBoundaryStartedAt) {
          this.store.putOperation({
            ...op,
            preSendBoundaryStartedAt: startedAt,
          });
        }
      }
    });
    if (!shouldSend) return;

    const latestStop = this.store.task(taskId).resolution.ownerStop;
    const intent = {
      verb: "stop",
      runId: cancellation.runId,
      role: cancellation.role,
      agentId: cancellation.agentId,
      workspaceId: cancellation.workspaceId,
      turnId: cancellation.turnId,
      effectId: cancellation.effectId,
      operationId: latestStop?.operationId ?? null,
    };
    try {
      await this.engine.host.stopAgentTurn(cancellation.agentId);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      this.store.transaction(() => {
        const current = this.store.task(taskId);
        const stop = current.resolution.ownerStop;
        if (!stop) return;
        const updated = stop.cancellations.map((c) =>
          c.effectId === cancellation.effectId
            ? { ...c, status: "uncertain" as const, note: message }
            : c,
        );
        this.store.event(
          taskId,
          "owner_stop_uncertain",
          JSON.stringify({ ...intent, status: "uncertain", message }),
        );
        this.store.update(
          taskId,
          { resolution: { ...current.resolution, ownerStop: { ...stop, cancellations: updated } } },
          "owner_stop_uncertain_recorded",
          `Owner stop cancellation uncertain on ${cancellation.runId}: ${message}`,
        );
      });
      return;
    }
    this.store.transaction(() => {
      const current = this.store.task(taskId);
      const stop = current.resolution.ownerStop;
      if (!stop) return;
      const updated = stop.cancellations.map((c) =>
        c.effectId === cancellation.effectId
          ? { ...c, status: "sent" as const, note: null }
          : c,
      );
      this.store.event(
        taskId,
        "owner_stop_sent",
        JSON.stringify({ ...intent, status: "sent" }),
      );
      this.store.update(
        taskId,
        { resolution: { ...current.resolution, ownerStop: { ...stop, cancellations: updated } } },
        "owner_stop_sent_recorded",
        `Owner stop cancellation sent for ${cancellation.runId}`,
      );
    });
  }

  private async observeOrResumeParticipant(
    taskId: string,
    cancellation: OwnerStopCancellation,
  ): Promise<void> {
    const taskBefore = this.store.task(taskId);
    const stopBefore = taskBefore.resolution.ownerStop;
    if (!stopBefore) return;
    const terminalOrDisposed =
      Boolean(taskBefore.removedAt) ||
      ["done", "cancelled"].includes(taskBefore.phase) ||
      Boolean(taskBefore.resolution.mergedCommit) ||
      isDispositionActive(taskBefore);

    // Pre-boundary binding check without touching the host.
    if (cancellation.boundaryStartedAt === null) {
      if (terminalOrDisposed) {
        this.store.transaction(() => {
          const cur = this.store.task(taskId);
          const curStop = cur.resolution.ownerStop;
          if (!curStop) return;
          const updated = curStop.cancellations.map((c) =>
            c.effectId === cancellation.effectId
              ? {
                  ...c,
                  status: "settled" as const,
                  settledKind: "task_disposed" as const,
                  note: "Task reached terminal or disposed state before cancellation boundary",
                }
              : c,
          );
          this.store.update(
            taskId,
            { resolution: { ...cur.resolution, ownerStop: { ...curStop, cancellations: updated } } },
            "owner_stop_progress",
            `Settled pre-boundary stop on ${cancellation.runId} after task transition`,
          );
        });
        return;
      }
      const runRows = this.store.runs(taskId);
      const stillBound = cancellation.isInitialWorker
        ? taskBefore.agentId === cancellation.agentId && taskBefore.workspaceId === cancellation.workspaceId
        : runRows.some(
            (r) =>
              r.id === cancellation.runId &&
              !r.released &&
              !r.completion &&
              r.agentId === cancellation.agentId &&
              r.workspaceId === cancellation.workspaceId,
          );
      if (!stillBound) {
        this.store.transaction(() => {
          const cur = this.store.task(taskId);
          const curStop = cur.resolution.ownerStop;
          if (!curStop) return;
          const updated = curStop.cancellations.map((c) =>
            c.effectId === cancellation.effectId
              ? {
                  ...c,
                  status: "settled" as const,
                  settledKind: "observed_inactive" as const,
                  note: "Run binding released or completed before cancellation boundary",
                }
              : c,
          );
          this.store.event(
            taskId,
            "owner_stop_settled",
            JSON.stringify({
              verb: "stop",
              runId: cancellation.runId,
              role: cancellation.role,
              agentId: cancellation.agentId,
              workspaceId: cancellation.workspaceId,
              turnId: cancellation.turnId,
              effectId: cancellation.effectId,
              operationId: curStop.operationId,
              status: "observed_inactive",
              observedStatus: "released",
            }),
          );
          this.store.update(
            taskId,
            { resolution: { ...cur.resolution, ownerStop: { ...curStop, cancellations: updated } } },
            "owner_stop_progress",
            `Settled pre-boundary stop on ${cancellation.runId}: run already settled`,
          );
        });
        return;
      }
    }

    let observed: Awaited<ReturnType<Adapter["observe"]>> | null = null;
    let observeError: string | null = null;
    try {
      observed = await this.engine.host.observe(cancellation.agentId);
    } catch (error) {
      observeError = error instanceof Error ? error.message : String(error);
    }

    if (observeError !== null || !observed || observed.id !== cancellation.agentId || observed.workspaceId !== cancellation.workspaceId) {
      const reason =
        observeError !== null
          ? `Agent cannot be observed (${observeError})`
          : !observed || observed.id !== cancellation.agentId
            ? "Observed agent identity does not match the run"
            : "Observed agent workspace does not match the run";
      this.store.transaction(() => {
        const cur = this.store.task(taskId);
        const curStop = cur.resolution.ownerStop;
        if (!curStop) return;
        const prev = curStop.cancellations.find((c) => c.effectId === cancellation.effectId);
        if (!prev || (prev.status === "uncertain" && prev.note === reason.slice(0, 2000))) return;
        const updated = curStop.cancellations.map((c) =>
          c.effectId === cancellation.effectId
            ? { ...c, status: "uncertain" as const, note: reason.slice(0, 2000) }
            : c,
        );
        this.store.update(
          taskId,
          { resolution: { ...cur.resolution, ownerStop: { ...curStop, cancellations: updated } } },
          "owner_stop_progress",
          `Owner stop observation inconclusive for ${cancellation.runId}: ${reason}`,
        );
      });
      return;
    }

    const ownedHold =
      observed.status !== "closed" &&
      Boolean(await this.engine.ownedToolHold(cancellation.agentId, cancellation.runId, taskId));
    const inactive =
      matchingInactiveParticipant(
        { agentId: cancellation.agentId, workspaceId: cancellation.workspaceId },
        observed,
      ) && !ownedHold;

    if (inactive) {
      const observedAt = now();
      this.store.transaction(() => {
        const cur = this.store.task(taskId);
        const curStop = cur.resolution.ownerStop;
        if (!curStop) return;
        if (cancellation.isInitialWorker && cur.agentId === cancellation.agentId) {
          this.store.update(
            taskId,
            {
              lastAgentStatus: observed!.status,
              agentActive: false,
              lastObservedAt: observedAt,
              idleSince: cur.idleSince ?? observedAt,
            },
            "owner_stop_observed_idle",
            `Observed ${cancellation.agentId} ${observed!.status}`,
          );
        } else {
          const run = this.store.run(cancellation.runId);
          if (run && !run.released) {
            this.store.putRun({
              ...run,
              active: false,
              lastObservedAt: observedAt,
              idleSince: run.idleSince ?? observedAt,
            });
          }
        }
        const refreshed = this.store.task(taskId);
        const stopLatest = refreshed.resolution.ownerStop ?? curStop;
        const updated = stopLatest.cancellations.map((c) =>
          c.effectId === cancellation.effectId
            ? {
                ...c,
                status: "settled" as const,
                settledKind: "observed_inactive" as const,
                note: `Observed ${observed!.status} with no active turn`,
              }
            : c,
        );
        this.store.event(
          taskId,
          "owner_stop_settled",
          JSON.stringify({
            verb: "stop",
            runId: cancellation.runId,
            role: cancellation.role,
            agentId: cancellation.agentId,
            workspaceId: cancellation.workspaceId,
            turnId: cancellation.turnId,
            effectId: cancellation.effectId,
            operationId: stopLatest.operationId,
            status: "observed_inactive",
            observedStatus: observed!.status,
          }),
        );
        this.store.update(
          taskId,
          { resolution: { ...refreshed.resolution, ownerStop: { ...stopLatest, cancellations: updated } } },
          "owner_stop_progress",
          `Settled stop on ${cancellation.runId}: observed ${observed!.status}`,
        );
      });
      return;
    }

    // Participant is still active / holding permissions / owned tool hold.
    const observedTurn = observed.activeTurnId ?? null;
    if (cancellation.turnId !== null && observedTurn && observedTurn !== cancellation.turnId) {
      const msg = `Intended turn ${cancellation.turnId} ended; newer active turn ${observedTurn} left untouched`;
      this.store.transaction(() => {
        const cur = this.store.task(taskId);
        const curStop = cur.resolution.ownerStop;
        if (!curStop) return;
        const updated = curStop.cancellations.map((c) =>
          c.effectId === cancellation.effectId
            ? {
                ...c,
                status: "settled" as const,
                settledKind: "newer_turn_untouched" as const,
                untouchedTurnId: observedTurn,
                note: msg,
              }
            : c,
        );
        this.store.event(
          taskId,
          "owner_stop_settled",
          JSON.stringify({
            verb: "stop",
            runId: cancellation.runId,
            role: cancellation.role,
            agentId: cancellation.agentId,
            workspaceId: cancellation.workspaceId,
            turnId: cancellation.turnId,
            effectId: cancellation.effectId,
            operationId: curStop.operationId,
            status: "newer_turn_untouched",
            untouchedTurnId: observedTurn,
          }),
        );
        this.store.update(
          taskId,
          { resolution: { ...cur.resolution, ownerStop: { ...curStop, cancellations: updated } } },
          "owner_stop_progress",
          msg,
        );
      });
      return;
    }

    if (cancellation.boundaryStartedAt !== null) {
      const msg = "Agent remains active after stop boundary; cancellation delivery is unconfirmed";
      this.store.transaction(() => {
        const cur = this.store.task(taskId);
        const curStop = cur.resolution.ownerStop;
        if (!curStop) return;
        const prev = curStop.cancellations.find((c) => c.effectId === cancellation.effectId);
        if (!prev || (prev.status === "uncertain" && prev.note === msg)) return;
        const updated = curStop.cancellations.map((c) =>
          c.effectId === cancellation.effectId
            ? { ...c, status: "uncertain" as const, note: msg }
            : c,
        );
        this.store.update(
          taskId,
          { resolution: { ...cur.resolution, ownerStop: { ...curStop, cancellations: updated } } },
          "owner_stop_progress",
          msg,
        );
      });
      return;
    }

    // Boundary was NEVER crossed (`boundaryStartedAt === null`) and agent is busy.
    // Only send if turn binding matches unambiguously; otherwise wait under the hold.
    const ambiguousTurn =
      (cancellation.turnId !== null && observedTurn !== cancellation.turnId) ||
      (cancellation.turnId === null && Boolean(observedTurn)) ||
      terminalOrDisposed;
    if (ambiguousTurn) {
      const msg = terminalOrDisposed
        ? "Task changed disposition while stop waited before boundary"
        : "Active turn identity is ambiguous across interruption; refusing blind replay";
      this.store.transaction(() => {
        const cur = this.store.task(taskId);
        const curStop = cur.resolution.ownerStop;
        if (!curStop) return;
        const prev = curStop.cancellations.find((c) => c.effectId === cancellation.effectId);
        if (!prev || (prev.status === "uncertain" && prev.note === msg)) return;
        const updated = curStop.cancellations.map((c) =>
          c.effectId === cancellation.effectId
            ? { ...c, status: "uncertain" as const, note: msg }
            : c,
        );
        this.store.event(
          taskId,
          "owner_stop_uncertain",
          JSON.stringify({
            verb: "stop",
            runId: cancellation.runId,
            role: cancellation.role,
            agentId: cancellation.agentId,
            workspaceId: cancellation.workspaceId,
            turnId: cancellation.turnId,
            effectId: cancellation.effectId,
            operationId: curStop.operationId,
            status: "uncertain",
            message: msg,
          }),
        );
        this.store.update(
          taskId,
          { resolution: { ...cur.resolution, ownerStop: { ...curStop, cancellations: updated } } },
          "owner_stop_progress",
          msg,
        );
      });
      return;
    }

    // Exact pre-boundary turn/run/workspace match proven; execute cancellation now.
    await this.cancelParticipantBoundary(taskId, cancellation);
  }

  private async driveOwnerStop(
    taskId: string,
    mode: "execute" | "resume" | "observe",
  ): Promise<Task> {
    const initial = this.store.task(taskId);
    const stop = initial.resolution.ownerStop;
    if (!stop) return initial;

    if (mode === "observe") {
      if (!initial.hostId || !this.engine.taskHostAvailable(initial)) {
        return initial;
      }
    }

    for (const cancellation of stop.cancellations) {
      if (cancellation.status === "sent" || cancellation.status === "settled") continue;
      if (mode === "execute" && cancellation.boundaryStartedAt === null) {
        await this.cancelParticipantBoundary(taskId, cancellation);
      } else {
        await this.observeOrResumeParticipant(taskId, cancellation);
      }
    }

    const afterLoop = this.store.task(taskId);
    const latestStop = afterLoop.resolution.ownerStop;
    if (!latestStop) return afterLoop;

    const unresolved = latestStop.cancellations.filter(
      (c) => c.status !== "sent" && c.status !== "settled",
    );
    if (unresolved.length === 0) {
      const settledTask = this.store.transaction(() => {
        const cur = this.store.task(taskId);
        const curStop = cur.resolution.ownerStop;
        if (!curStop) return cur;
        const stillUnresolved = curStop.cancellations.some(
          (c) => c.status !== "sent" && c.status !== "settled",
        );
        if (stillUnresolved) return cur;
        const phaseBefore = cur.phase;
        const untouchedNotes = curStop.cancellations
          .filter((c) => c.settledKind === "newer_turn_untouched" && c.note)
          .map((c) => c.note!);
        const issues = [
          curStop.nonTransientIssue ?? "",
          ...untouchedNotes,
        ].filter(Boolean);
        const detail = this.holdWaitDetail(cur, issues);
        if (cur.resolution.stop?.reason !== "held" || cur.resolution.stop?.detail !== detail)
          this.resolution.waiting(cur, detail, "held");
        const held = this.store.task(taskId);
        const nextTask = this.store.update(
          taskId,
          {
            resolution: {
              ...held.resolution,
              ownerStop: null,
              integrationTurn: null,
            },
          },
          "owner_stopped_settled",
          `Owner stop settled: ${curStop.reason}`,
        );
        const cancelled = curStop.cancellations
          .filter((c) => c.status === "sent")
          .map((c) => ({ runId: c.runId, role: c.role, agentId: c.agentId }));
        const settled = curStop.cancellations
          .filter((c) => c.status === "settled")
          .map((c) => ({
            runId: c.runId,
            role: c.role,
            agentId: c.agentId,
            kind: c.settledKind,
            untouchedTurnId: c.untouchedTurnId,
          }));
        this.store.event(
          taskId,
          "owner_stopped",
          JSON.stringify({
            role: curStop.role,
            reason: curStop.reason,
            runIds: curStop.targetRunIds,
            cancelled,
            ...(settled.length ? { settled } : {}),
            ...(curStop.executorContinues.length ? { executorContinues: curStop.executorContinues } : {}),
            ...(curStop.mergeRequested
              ? { mergeAlreadyRequested: { head: curStop.mergeHead, requestedAt: curStop.mergeRequestedAt } }
              : {}),
            ...(curStop.operationId ? { operationId: curStop.operationId } : {}),
          }),
        );
        this.commitOperationSuccessInTx(curStop.operationId, nextTask, mode === "observe");
        if (mode === "observe") {
          this.recordAuditForObservedSettle(nextTask, curStop, phaseBefore);
        }
        return this.store.task(taskId);
      });
      return settledTask;
    }

    // Some cancellations remain unresolved / uncertain: keep visible wait under hold.
    const issueSummary = unresolved
      .map((u) => `Turn cancellation for ${u.runId} is unconfirmed (${u.note || u.status})`)
      .join("; ");
    this.store.transaction(() => {
      const cur = this.store.task(taskId);
      const curStop = cur.resolution.ownerStop;
      if (!curStop) return;
      const detail = this.holdWaitDetail(cur, [curStop.nonTransientIssue ?? "", issueSummary]);
      if (cur.resolution.stop?.reason !== "held" || cur.resolution.stop?.detail !== detail)
        this.resolution.waiting(cur, detail, "held");
    });

    if (mode !== "observe") {
      const first = unresolved[0]!;
      throw Error(
        `Nucleus could not stop the live ${first.role} run (${first.runId}): ${first.note || "cancellation delivery is uncertain"}; confirmation remains pending under the hold`,
      );
    }
    return this.store.task(taskId);
  }

  /** Observe and settle any pending durable owner stop on a task (called by Sweep / Operations / follow-up verbs). */
  async observeOwnerStop(taskId: string): Promise<Task | null> {
    const task = this.store.task(taskId);
    if (!task.resolution.ownerStop) return null;
    return this.engine.control(async () => {
      const current = this.store.task(taskId);
      if (!current.resolution.ownerStop) return current;
      return this.driveOwnerStop(taskId, "observe");
    }, `task:${taskId}`);
  }

  /** Resume an interrupted owner `stop` operation for `operationId`. */
  async resumeOwnerStop(input: TaskControlInput, operationId: string): Promise<Task> {
    return this.engine.control(async () => {
      const task = this.store.task(input.taskId);
      if (task.resolution.ownerStop?.operationId === operationId) {
        return this.driveOwnerStop(task.id, "resume");
      }
      // If `ownerStop` is null, check if this operation already completed cleanly.
      const op = this.store.operation(operationId);
      if (op?.result?.taskId && op.effect?.status === "reconciled" && !op.preSendReceipt) {
        return task;
      }
      if (task.resolution.ownerStop) {
        await this.driveOwnerStop(task.id, "observe");
        const refreshed = this.store.task(input.taskId);
        if (refreshed.resolution.ownerStop) {
          throw new DurableFenceRefusal(ownerStopPendingRefusal(refreshed.resolution.ownerStop));
        }
      }
      return this.performStopInControl(input, operationId);
    }, `task:${input.taskId}`);
  }

  /**
   * Round 4 `stop` (Tom, 2026-10-19): halt the task's live work now and park it
   * under an owner dispatch hold. Once preflight admits the stop, the hold,
   * held-wait record and per-participant cancellation intents are committed
   * durably before crossing the native cancellation boundary.
   */
  async stopTask(input: TaskControlInput, operationId?: string): Promise<Task> {
    const reason = (input.reason ?? "").trim();
    if (!reason) throw Error("stop requires a reason");
    return this.engine.control(async () => {
      const initial = this.store.task(input.taskId);
      if (operationId && initial.resolution.ownerStop?.operationId === operationId) {
        return this.driveOwnerStop(initial.id, "resume");
      }
      if (initial.removedAt) throw Error(REMOVED_TASK_REFUSAL);
      this.engine.requireOwnerControlCurrent(initial, input.version, "Task changed; refresh before retrying");
      if (initial.resolution.ownerStop) {
        await this.driveOwnerStop(initial.id, "observe");
        const afterObserve = this.store.task(input.taskId);
        if (afterObserve.resolution.ownerStop) {
          throw new DurableFenceRefusal(ownerStopPendingRefusal(afterObserve.resolution.ownerStop));
        }
      }
      return this.performStopInControl(input, operationId);
    }, `task:${input.taskId}`);
  }

  private async performStopInControl(input: TaskControlInput, operationId?: string): Promise<Task> {
    const reason = (input.reason ?? "").trim();
    const task = this.store.task(input.taskId);
    if (task.removedAt) throw Error(REMOVED_TASK_REFUSAL);
    if (
      task.resolution.integrationTurn &&
      (isDispositionActive(task) || ["done", "cancelled"].includes(task.phase) || task.resolution.mergedCommit)
    ) {
      return this.store.transaction(() => {
        const nextTask = this.store.update(
          task.id,
          { resolution: { ...task.resolution, integrationTurn: null } },
          "integration_turn_released",
          `stop: ${reason}`,
        );
        this.commitOperationSuccessInTx(operationId, nextTask, false);
        return nextTask;
      });
    }
    const refusal = stopStateRefusal(task);
    if (refusal) throw Error(refusal);
    const role = input.role as RouteRole | undefined;
    const roleOf = (run: Run): RouteRole =>
      run.role === "reviewer" ? "reviewer" : run.role === "revision" ? "worker" : "coordinator";
    // nucleus#1195: a live proof executor is never interrupted by an owner stop.
    const runRowsBefore = this.store.runs(task.id);
    const liveExecutors = runRowsBefore.filter(
      (run) => run.role === "executor" && !run.released && !run.completion,
    );
    let collectionIssue = "";
    const finished = await this.engine
      .collectVerbFinishedRuns(
        task.id,
        (run) => run.role === "executor" || (role !== undefined && roleOf(run) !== role),
        { displace: true },
      )
      .catch((error) => {
        if (!task.resolution.integrationTurn) throw error;
        collectionIssue = String(error);
        return { settleable: [], fenced: [], live: [], observations: new Map<string, Awaited<ReturnType<Adapter["observe"]>>>() };
      });
    if (finished.fenced.length && !task.resolution.integrationTurn)
      throw new DurableFenceRefusal(this.engine.displaceRefusal(finished.fenced[0]!));

    const busy = [...finished.live];
    const observations = new Map(finished.observations);
    let isInitialBusy = false;
    let initialRun: Run | null = null;
    let stopIssue = [
      collectionIssue,
      ...finished.fenced.map((item) => this.engine.displaceRefusal(item)),
    ]
      .filter(Boolean)
      .join("; ");

    // The initial worker lives on the task row, never as a Run.
    if (
      (role === undefined || role === "worker") &&
      task.agentId &&
      task.workspaceId &&
      !runRowsBefore.some((run) => !run.released && run.agentId === task.agentId)
    ) {
      initialRun = {
        id: task.runId ?? `initial-worker-${task.id}`,
        taskId: task.id,
        role: "revision",
        agentId: task.agentId,
        workspaceId: task.workspaceId,
      } as Run;
      try {
        const result = await this.engine.displacedRunObservation(initialRun);
        observations.set(initialRun.id, result.observation);
        if (result.busy) {
          busy.push(initialRun);
          isInitialBusy = true;
        }
      } catch (error) {
        if (!task.resolution.integrationTurn) throw error;
        stopIssue = [stopIssue, String(error)].filter(Boolean).join("; ");
      }
    }

    if (busy.length > 0 && !this.adapter.stopAgentTurn) {
      const host = HOST_KIND_LABELS[hostKindOf(task.hostId)];
      const unavailableMsg = `${host} active-turn cancellation is unavailable, so Nucleus cannot stop the live run; retry once ${host} offers it`;
      if (!task.resolution.integrationTurn) throw new DurableFenceRefusal(unavailableMsg);
      stopIssue = [stopIssue, unavailableMsg].filter(Boolean).join("; ");
    }

    // All preflight checks succeeded without mutating anything. Now atomically revalidate
    // and commit the dispatch hold, held wait, and exact cancellation intents BEFORE
    // crossing the native `stopAgentTurn` boundary.
    const canCancel = Boolean(this.adapter.stopAgentTurn);
    const committedImmediate = this.store.transaction(() => {
      const current = this.store.task(task.id);
      const currentRuns = this.store.runs(task.id);
      if (current.removedAt) throw Error(REMOVED_TASK_REFUSAL);
      if (
        !observationAdvanceSince(current, task.version) ||
        !runsUnchangedSince(runRowsBefore, currentRuns) ||
        current.resolution.ownerStop !== null
      ) {
        throw new TaskChangedRefusal(
          "Task changed while preparing stop; refresh before retrying",
          input.version,
          current.version,
        );
      }

      const { mergeRequested, mergeHead, mergeNote } = this.mergeNoteFor(current);
      const holdReason =
        `Owner stop: ${reason}${mergeNote}${stopIssue ? ` Remaining activity needs attention: ${stopIssue}` : ""}`.slice(
          0,
          4000,
        );
      if (!holdsOf(current).dispatch) {
        this.store.update(
          current.id,
          holdPatch(current, "dispatch", input.caller ?? OPERATOR_HOLD_OWNER, holdReason, null),
          "hold",
          holdReason,
        );
      }

      const stoppedRunIds = new Set(busy.map((run) => run.id));
      for (const run of currentRuns) {
        if (run.role === "executor") continue;
        const targeted =
          role === undefined ||
          (role === "reviewer"
            ? run.role === "reviewer"
            : role === "worker"
              ? run.role === "revision"
              : !["reviewer", "revision"].includes(run.role));
        if (targeted && !run.released && !run.completion) stoppedRunIds.add(run.id);
      }
      if (
        (role === undefined || role === "worker") &&
        current.runId &&
        current.agentId &&
        !currentRuns.some((run) => run.id === current.runId)
      )
        stoppedRunIds.add(current.runId);

      const executorContinues = liveExecutors.map((run) => ({
        runId: run.id,
        agentId: run.agentId ?? null,
      }));
      const cancellations: OwnerStopCancellation[] = canCancel
        ? busy.map((run) => {
            const obs = observations.get(run.id);
            const effectKey = `${task.id}:${run.id}:${run.agentId ?? ""}:${operationId ?? current.version}`;
            return {
              runId: run.id,
              role: run.role,
              agentId: run.agentId!,
              workspaceId: run.workspaceId ?? null,
              turnId: obs?.activeTurnId ?? null,
              effectId: `ns-owner-stop-${digest(effectKey).slice(0, 32)}`,
              isInitialWorker: Boolean(isInitialBusy && initialRun && run.id === initialRun.id),
              status: "intent" as const,
              boundaryStartedAt: null,
              settledKind: null,
              untouchedTurnId: null,
              note: null,
            };
          })
        : [];

      if (cancellations.length === 0) {
        this.resolution.waiting(
          this.store.task(task.id),
          this.holdWaitDetail(this.store.task(task.id), [stopIssue]),
          "held",
        );
        let held = this.store.task(task.id);
        if (held.resolution.integrationTurn || held.resolution.ownerStop !== null) {
          held = this.store.update(
            held.id,
            {
              resolution: {
                ...held.resolution,
                integrationTurn: null,
                ownerStop: null,
              },
            },
            held.resolution.integrationTurn ? "integration_turn_released" : "owner_stopped_settled",
            `stop: ${reason}`,
          );
        }
        this.store.event(
          task.id,
          "owner_stopped",
          JSON.stringify({
            role: role ?? null,
            reason,
            runIds: [...stoppedRunIds],
            cancelled: [],
            ...(executorContinues.length ? { executorContinues } : {}),
            ...(mergeRequested
              ? {
                  mergeAlreadyRequested: {
                    head: current.resolution.mergeHead ?? null,
                    requestedAt: current.resolution.mergeRequestedAt ?? null,
                  },
                }
              : {}),
            ...(operationId ? { operationId } : {}),
          }),
        );
        const recorded = held.resolution.deferredVerb;
        if (recorded) {
          this.engine.dropDeferredOwnerVerb(
            task.id,
            recorded.at,
            "deferred_verb_dropped",
            `${String(recorded.input.action)}: superseded by stop`,
          );
        }
        this.commitOperationSuccessInTx(operationId, this.store.task(task.id), false);
        return this.store.task(task.id);
      }

      // Live runs need native cancellation: commit `ownerStop` + `owner_stop_intent` + held wait now.
      this.resolution.waiting(
        this.store.task(task.id),
        this.holdWaitDetail(this.store.task(task.id), [stopIssue]),
        "held",
      );
      const waitingTask = this.store.task(task.id);
      const ownerStopRecord: OwnerStopRecord = {
        operationId: operationId ?? null,
        taskVersion: current.version,
        role: role ?? null,
        reason,
        caller: input.caller ?? null,
        targetRunIds: [...stoppedRunIds],
        hadIntegrationTurn: Boolean(current.resolution.integrationTurn),
        mergeRequested,
        mergeHead: current.resolution.mergeHead ?? null,
        mergeRequestedAt: current.resolution.mergeRequestedAt ?? null,
        executorContinues,
        nonTransientIssue: stopIssue || null,
        cancellations,
        recordedAt: now(),
      };
      this.store.update(
        task.id,
        {
          resolution: {
            ...waitingTask.resolution,
            integrationTurn: null,
            ownerStop: ownerStopRecord,
          },
        },
        waitingTask.resolution.integrationTurn ? "integration_turn_released" : "owner_stop_accepted",
        `Accepted owner stop: ${reason}`,
      );
      for (const c of cancellations) {
        this.store.event(
          task.id,
          "owner_stop_intent",
          JSON.stringify({
            verb: "stop",
            runId: c.runId,
            role: c.role,
            agentId: c.agentId,
            workspaceId: c.workspaceId,
            turnId: c.turnId,
            effectId: c.effectId,
            operationId: operationId ?? null,
            status: "intent",
          }),
        );
      }
      const recorded = this.store.task(task.id).resolution.deferredVerb;
      if (recorded) {
        this.engine.dropDeferredOwnerVerb(
          task.id,
          recorded.at,
          "deferred_verb_dropped",
          `${String(recorded.input.action)}: superseded by stop`,
        );
      }
      return null;
    });

    if (committedImmediate) return committedImmediate;
    return this.driveOwnerStop(task.id, "execute");
  }
}
