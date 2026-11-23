import { propagateQuantumDeferral } from "../scheduling/pass-snapshot";
import type { Task, TaskControlInput } from "../../shared/contracts";
import { TaskChangedRefusal, taskChangedHint } from "../../shared/task-version";
import type { Engine } from "../engine";
import { HostReadRefusalError } from "../host/errors";

/**
 * Apply one owner control and record its outcome (round 4: the applied and
 * refused rate is measurable). The durable operation is the authority: a
 * control whose effect reconciled without ever crossing its pre-send boundary
 * already landed, so its recorded result answers the call instead of a refusal.
 *
 * A stale-version refusal names the version the task is now at and the read to
 * make, so a caller re-reads `next` once instead of resending the stale payload
 * (lean audit 2026-10-15). The hint comes from the typed refusal, never from its
 * words. The durable operation owns retries of incomplete host reads.
 */
export async function applyControlWithVersionHint(
  engine: Engine,
  input: TaskControlInput,
  operationId?: string,
): Promise<Task> {
  const recordOutcome = (outcome: "applied" | "refused", reason?: string) => {
    if (
      engine.coordinatorActionRunId.getStore() ||
      engine.replayingDeferredVerb.getStore()
    )
      return;
    try {
      engine.store.recordVerbOutcome(
        input.taskId,
        input.action,
        outcome,
        "owner",
        {
          ...(input.to ? { to: input.to } : {}),
          ...(input.role ? { role: input.role } : {}),
          caller: input.caller ?? null,
          ...(reason ? { reason: reason.slice(0, 600) } : {}),
        },
        operationId ? `operation:${operationId}` : null,
      );
    } catch {
      /* the outcome stands even if its record could not be written */
    }
  };
  let applied: Task;
  try {
    applied = await engine.performTaskControlApplied(input, operationId);
  } catch (error) {
    const committed = operationId ? engine.store.operation(operationId) : null;
    if (
      committed?.result &&
      committed.effect?.status === "reconciled" &&
      (!committed.preSendBoundaryStartedAt ||
        (committed.kind === "task_control" &&
          committed.effect.kind === "task_control" &&
          committed.effect.target === "stop"))
    ) {
      recordOutcome("applied");
      return engine.store.task(input.taskId);
    }
    propagateQuantumDeferral(error);
    if (
      !committed?.preSendBoundaryStartedAt &&
      committed &&
      error instanceof HostReadRefusalError
    )
      throw error;
    const message = error instanceof Error ? error.message : String(error);
    recordOutcome("refused", message);
    // Keep the pre-send type when adding the same actionable version hint: a
    // stale version is the one refusal whose reader is the caller's own re-read.
    if (error instanceof TaskChangedRefusal) {
      let current: number | undefined;
      try {
        current = engine.store.task(input.taskId).version;
      } catch {
        /* a missing task keeps the original refusal */
      }
      if (current !== undefined && current !== input.version)
        throw new TaskChangedRefusal(
          taskChangedHint(message, current),
          input.version,
          current,
        );
    }
    throw error;
  }
  if (input.action === "release") {
    try {
      await engine.applyDeferredOwnerVerbs();
    } catch {
      /* the durable deferred record remains available to the next pass */
    }
    applied = engine.store.task(input.taskId);
    void engine.cleanContext(() => engine.wakeTask(applied.id));
    void engine.cleanContext(() => engine.wakeRepository(applied.repoPath));
  }
  recordOutcome("applied");
  return applied;
}
