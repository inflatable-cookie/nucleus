import { REMOVED_TASK_REFUSAL } from "./control-refusals";
import { HOST_KIND_LABELS, hostKindOf } from "../../shared/host-kind";

import type { Run, Task } from "../../shared/contracts";
import { dispatchBlocked } from "../dispatch/capacity";
import { digest, now } from "../store/store";
import type { Engine } from "../engine";

/**
 * Operator-authorized exit for one detected hung worker or reviewer turn. The
 * task and run identity are checked before and after the live observation; the
 * stop intent and stable effect ID are durable before cancellation. Unknown
 * delivery is observed before one explicitly requested retry, and a stale
 * assignment refuses without sending anything.
 */
export class StalledTurnStops {
  constructor(readonly engine: Engine) {}
  get store() {
    return this.engine.store;
  }
  get adapter() {
    return this.engine.adapter;
  }
  get resolution() {
    return this.engine.resolution;
  }

  async stopStalledTurn(input: {
    taskId: string;
    version: number;
    runId: string;
  }): Promise<Task> {
    return this.engine.control(async () => {
      let task = this.store.task(input.taskId);
      if (task.removedAt) throw Error(REMOVED_TASK_REFUSAL);
      if (this.engine.stopped || this.store.getMeta("paused"))
        throw Error("Nucleus is paused; stalled-turn stop is deferred");
      if (dispatchBlocked(task))
        throw Error("A dispatch hold is active; stalled-turn stop is deferred");
      this.engine.requireOwnerControlCurrent(
        task,
        input.version,
        "Task changed; refresh before stopping its retained turn",
      );
      this.engine.rejectFenced(task, "stalled-turn stop");
      if (!this.adapter.stopAgentTurn)
        throw Error(
          `${HOST_KIND_LABELS[hostKindOf(task.hostId)]} active-turn cancellation is unavailable`,
        );

      const target = (current: Task) => {
        const incident = current.resolution.incident;
        if (
          !current.resolution.attention ||
          incident?.cause !== "stalled_turn" ||
          incident.runId !== input.runId ||
          incident.status === "resolved"
        )
          throw Error(
            "This task has no current stalled-turn incident for that exact run",
          );
        if (!incident.turnId)
          throw Error(
            "The stall incident has no recorded active turn ID; Nucleus cannot prove which turn to interrupt",
          );
        if (
          current.resolution.mergeIntent ||
          current.resolution.mergedCommit ||
          ["done", "cancelled"].includes(current.phase)
        )
          throw Error("A stalled-turn stop requires live, unmerged task work");
        const targetRun = this.store.run(input.runId);
        const assignedAgent =
          current.runId === input.runId && !current.resolution.currentRunId
            ? current.agentId
            : targetRun?.agentId;
        const otherRun = this.store
          .unreleasedRunsForAgent(assignedAgent ?? "", current.hostId)
          .find((candidate) => candidate.taskId !== current.id);
        if (otherRun)
          throw Error(
            `Agent ${otherRun.agentId} also owns unreleased ${otherRun.role} run ${otherRun.id} on task ${otherRun.taskId}; no turn was stopped`,
          );
        const otherWorker = assignedAgent
          ? this.store
              .activeCapacityTasks()
              .find(
                (candidate) =>
                  candidate.id !== current.id &&
                  (!candidate.hostId ||
                    !current.hostId ||
                    candidate.hostId === current.hostId) &&
                  candidate.agentId === assignedAgent &&
                  [
                    "working",
                    "dispatching",
                    "needs_attention",
                    "blocked",
                    "error",
                  ].includes(candidate.phase) &&
                  !candidate.resolution.currentRunId,
              )
          : undefined;
        if (otherWorker)
          throw Error(
            `Agent ${assignedAgent} is also assigned to task ${otherWorker.id}; no turn was stopped`,
          );
        if (
          current.runId === input.runId &&
          current.agentId &&
          current.workspaceId &&
          !current.completion &&
          !current.resolution.currentRunId &&
          ["working", "needs_attention"].includes(current.phase)
        ) {
          if (current.prUrl || current.prHead || current.resumePrNumber)
            throw Error(
              "The initial worker turn has accepted PR identity; use its retained resolution controls",
            );
          if (this.store.runs(current.id).some((run) => !run.released))
            throw Error("Another retained run owns this task; stop is refused");
          return {
            role: "worker" as const,
            agentId: current.agentId,
            workspaceId: current.workspaceId,
            run: null as Run | null,
          };
        }
        const run = this.store.run(input.runId);
        if (
          !run ||
          run.taskId !== current.id ||
          run.released ||
          run.completion ||
          !run.agentId
        )
          throw Error(
            "The exact stalled run is no longer active; refresh task and run identity",
          );
        if (
          current.resolution.currentRunId !== run.id ||
          (run.role === "reviewer" &&
            run.agentId !== current.resolution.reviewerAgentId)
        )
          throw Error(
            "The exact stalled run is no longer the task’s assigned run",
          );
        if (
          (run.role !== "revision" && run.role !== "reviewer") ||
          run.workspaceId !== current.workspaceId ||
          (run.role === "revision" && run.agentId !== current.agentId)
        )
          throw Error(
            "Only the retained revision or reviewer run in this task workspace can be stopped",
          );
        if (
          run.role === "reviewer" &&
          (!current.prUrl || !current.prHead || run.head !== current.prHead)
        )
          throw Error(
            "The reviewer is not bound to the task’s current exact PR head",
          );
        if (
          run.role === "revision" &&
          (!current.prHead || run.head !== current.prHead)
        )
          throw Error(
            "The revision is not bound to the task’s current exact PR head",
          );
        if (
          this.store
            .runs(current.id)
            .some((candidate) => !candidate.released && candidate.id !== run.id)
        )
          throw Error("Another retained run owns this task; stop is refused");
        return {
          role: run.role,
          agentId: run.agentId,
          workspaceId: run.workspaceId,
          run,
        };
      };

      let assigned = target(task);
      const previous = task.resolution.stalledTurnStop;
      if (previous && previous.runId !== input.runId)
        throw Error(
          "A different stalled-turn stop is still recorded; settle it before targeting another run",
        );
      if (previous && ["stopped", "completed"].includes(previous.status))
        throw Error(
          `This stalled run is already ${previous.status}; no second stop will be sent`,
        );
      const observed = await this.engine.onTaskHost(task, () =>
        this.engine.host.observe(assigned.agentId),
      );
      if (this.engine.stopped || this.store.getMeta("paused"))
        throw Error(
          "Nucleus paused during stalled-turn observation; no stop was sent",
        );
      task = this.store.task(input.taskId);
      this.engine.requireOwnerControlCurrent(
        task,
        input.version,
        "Task changed during stalled-turn observation; no stop was sent",
      );
      assigned = target(task);
      if (
        observed.id !== assigned.agentId ||
        observed.workspaceId !== assigned.workspaceId
      )
        throw Error(
          "The assigned agent or workspace changed during stalled-turn proof; no stop was sent",
        );
      if (dispatchBlocked(task))
        throw Error(
          "A dispatch hold became active during stalled-turn observation; no stop was sent",
        );
      if (observed.permissions) {
        const reason = `The stalled ${assigned.role} run ${input.runId} now has an active permission request. Stop was refused; resolve or inspect that request before deciding again.`;
        this.store.update(
          task.id,
          { reason },
          "stalled_turn_stop_refused",
          reason,
        );
        throw Error(reason);
      }
      const observedBusy =
        observed.active ||
        ["running", "initializing"].includes(observed.status);
      if (!observedBusy) {
        if (
          previous &&
          ["intent", "uncertain", "sent"].includes(previous.status) &&
          ["idle", "error", "closed"].includes(observed.status)
        ) {
          this.resolution.reconcileStalledTurnStop(
            task,
            assigned.run,
            observed,
          );
          return this.store.task(task.id);
        }
        throw Error(
          "The exact turn is no longer active; no stop was sent. Let normal stopped-run reconciliation inspect it",
        );
      }
      if (!observed.activeTurnId)
        throw Error(
          `${HOST_KIND_LABELS[hostKindOf(task.hostId)]} did not expose the active turn ID; Nucleus cannot prove which turn would be interrupted`,
        );
      if (task.resolution.incident?.turnId !== observed.activeTurnId)
        throw Error(
          `The stalled turn changed from ${task.resolution.incident?.turnId ?? "unknown"} to ${observed.activeTurnId}; no interruption was sent`,
        );
      if (previous && previous.turnId !== observed.activeTurnId)
        throw Error(
          `The assigned agent is on a different active turn (${observed.activeTurnId}); no interruption was sent`,
        );
      if (previous?.status === "sent") return task;
      if (previous && previous.attempts >= 2)
        throw Error(
          "Stop delivery remains uncertain after one reconciled retry; inspect the retained thread before any further action",
        );

      const effectId =
        previous?.effectId ??
        `ns-stalled-stop-${digest(`${task.id}:${input.runId}:${assigned.agentId}:${observed.activeTurnId}`).slice(0, 32)}`;
      const intent = {
        runId: input.runId,
        role: assigned.role,
        agentId: assigned.agentId,
        workspaceId: assigned.workspaceId,
        turnId: observed.activeTurnId,
        effectId,
        status: "intent" as const,
        attempts: previous ? previous.attempts + 1 : 1,
        requestedAt: previous?.requestedAt ?? now(),
        observedInactiveAt: null,
        detail: previous
          ? `Retry authorized after a fresh observation of the same active turn ${observed.activeTurnId}`
          : `Operator authorized stopping detected stalled turn ${observed.activeTurnId}`,
      };
      task = this.store.transaction(() => {
        const current = this.store.task(input.taskId);
        if (
          current.version !== input.version ||
          this.store.getMeta("paused") ||
          dispatchBlocked(current)
        )
          throw Error(
            "Task version, pause or dispatch fence changed before stop intent; no interruption was sent",
          );
        const fresh = target(current);
        if (
          fresh.agentId !== assigned.agentId ||
          fresh.workspaceId !== assigned.workspaceId ||
          fresh.run?.id !== assigned.run?.id
        )
          throw Error(
            "The assigned run changed before stop intent; no interruption was sent",
          );
        return this.store.update(
          current.id,
          {
            resolution: { ...current.resolution, stalledTurnStop: intent },
            reason: `Operator stop requested for stalled ${assigned.role} run ${input.runId} turn ${intent.turnId}; waiting for observed inactivity. No replacement turn will start automatically`,
          },
          "stalled_turn_stop_intent",
          JSON.stringify(intent),
        );
      });
      const abandonUnsent = (reason: string): never => {
        const latest = this.store.task(input.taskId),
          currentStop = latest.resolution.stalledTurnStop;
        if (
          currentStop?.effectId === intent.effectId &&
          currentStop.status === "intent"
        ) {
          const visible = `No stop was sent for stalled ${assigned.role} run ${input.runId}: ${reason}. The original incident and run lease remain for owner inspection`;
          this.store.update(
            latest.id,
            {
              resolution: { ...latest.resolution, stalledTurnStop: null },
              reason: visible,
            },
            "stalled_turn_stop_refused",
            visible,
          );
        }
        throw Error(reason);
      };
      const beforeStop = await this.engine.onTaskHost(task, () =>
        this.engine.host.observe(assigned.agentId),
      );
      if (this.engine.stopped || this.store.getMeta("paused"))
        throw Error(
          "Nucleus paused during final stalled-turn proof; no stop was sent",
        );
      const latestBeforeStop = this.store.task(input.taskId);
      if (
        latestBeforeStop.version !== task.version ||
        dispatchBlocked(latestBeforeStop)
      )
        throw Error(
          "Task version or dispatch fence changed during final stalled-turn proof; no stop was sent",
        );
      let finalTarget: ReturnType<typeof target>;
      try {
        finalTarget = target(latestBeforeStop);
      } catch (error) {
        return abandonUnsent(
          error instanceof Error ? error.message : String(error),
        );
      }
      if (
        beforeStop.id !== assigned.agentId ||
        beforeStop.workspaceId !== assigned.workspaceId ||
        finalTarget.run?.id !== assigned.run?.id
      )
        return abandonUnsent(
          "assigned agent, workspace or run changed during final stalled-turn proof",
        );
      if (beforeStop.permissions)
        return abandonUnsent(
          "a permission request appeared during final stalled-turn proof",
        );
      if (
        !beforeStop.active ||
        !["running", "initializing"].includes(beforeStop.status)
      ) {
        if (["idle", "error", "closed"].includes(beforeStop.status)) {
          this.resolution.reconcileStalledTurnStop(
            latestBeforeStop,
            assigned.run,
            beforeStop,
          );
          return this.store.task(input.taskId);
        }
        return abandonUnsent(
          `the final live status is ${beforeStop.status}, so inactivity is unproved`,
        );
      }
      if (beforeStop.activeTurnId !== intent.turnId)
        return abandonUnsent(
          `active turn changed from ${intent.turnId} to ${beforeStop.activeTurnId ?? "unknown"}`,
        );
      try {
        await this.engine.onTaskHost(task, () =>
          this.engine.host.stopAgentTurn(assigned.agentId),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const latest = this.store.task(input.taskId),
          latestRun = assigned.run ? this.store.run(assigned.run.id) : null;
        const authenticCompletion =
          assigned.role === "worker"
            ? latest.completion?.runId === input.runId
            : latestRun?.completion?.runId === input.runId;
        if (
          authenticCompletion &&
          latest.resolution.stalledTurnStop?.runId === input.runId
        ) {
          const stop = {
            ...latest.resolution.stalledTurnStop,
            status: "completed" as const,
            detail:
              "Authentic authenticated completion arrived while stop delivery was uncertain; it was retained",
          };
          return this.store.update(
            latest.id,
            { resolution: { ...latest.resolution, stalledTurnStop: stop } },
            "stalled_turn_completion_preserved",
            input.runId,
          );
        }
        if (
          latest.resolution.stalledTurnStop?.runId === input.runId &&
          latest.resolution.stalledTurnStop.status === "intent"
        ) {
          const stop = {
            ...latest.resolution.stalledTurnStop,
            status: "uncertain" as const,
            detail: `Stop delivery is uncertain: ${message}`.slice(0, 2000),
          };
          const reason = `Stop delivery for stalled ${assigned.role} run ${input.runId} turn ${intent.turnId} is uncertain. Inspect the same retained turn before retrying; no duplicate stop was sent.`;
          this.store.update(
            latest.id,
            {
              resolution: { ...latest.resolution, stalledTurnStop: stop },
              reason,
            },
            "stalled_turn_stop_uncertain",
            stop.detail,
          );
        }
        throw Error(`Stalled-turn stop delivery is uncertain: ${message}`);
      }

      const latest = this.store.task(input.taskId),
        latestRun = assigned.run ? this.store.run(assigned.run.id) : null;
      const authenticCompletion =
        assigned.role === "worker"
          ? latest.completion?.runId === input.runId
          : latestRun?.completion?.runId === input.runId;
      if (
        authenticCompletion &&
        latest.resolution.stalledTurnStop?.runId === input.runId
      ) {
        const stop = {
          ...latest.resolution.stalledTurnStop,
          status: "completed" as const,
          detail:
            "Authentic authenticated completion arrived while the stop was being delivered; it was retained",
        };
        return this.store.update(
          latest.id,
          { resolution: { ...latest.resolution, stalledTurnStop: stop } },
          "stalled_turn_completion_preserved",
          input.runId,
        );
      }
      if (
        latest.resolution.stalledTurnStop?.runId !== input.runId ||
        latest.resolution.stalledTurnStop.status !== "intent"
      ) {
        this.store.event(
          latest.id,
          "stalled_turn_stop_delivery_reconciled",
          `${input.runId}/${intent.turnId}: interruption acknowledged after the task stop binding changed; current identities were retained`,
        );
        throw Error(
          "Task stop binding changed while the interruption was delivered; inspect the recorded run event before any further action",
        );
      }
      const statusReason = `Stop request sent for stalled ${assigned.role} run ${input.runId} turn ${intent.turnId}; waiting for Nucleus to observe inactivity. No replacement turn will start automatically`;
      return this.store.update(
        latest.id,
        {
          resolution: {
            ...latest.resolution,
            stalledTurnStop: {
              ...latest.resolution.stalledTurnStop,
              status: "sent",
              detail: `${HOST_KIND_LABELS[hostKindOf(latest.hostId)]} acknowledged the active-turn cancellation request`,
            },
          },
          reason: statusReason,
        },
        "stalled_turn_stop_sent",
        `${input.runId}/${intent.turnId}/${effectId}`,
      );
    }, `task:${input.taskId}`);
  }
}
