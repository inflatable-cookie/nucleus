import { now, type Store } from "../store/store";
import {
  creationProducerId,
  creationTermination,
  readCreationAttempt,
  type CreationBinding,
} from "../store/store-task-funnel";
import { threadRunningReason } from "../intake/thread-waits";
import { dispatchBlocked } from "../dispatch/capacity";
import { coordinative } from "./task-reasons";
import type { Run, Task } from "../../shared/contracts";
import type { Resolution } from "../resolution";

/**
 * Spec 068 §3: an uncertain creation settles by lookup, for every role.
 *
 * A launch whose native create call never answered leaves a run (or the initial
 * worker's binding) with no agent. The sweep looks the creation up by the labels
 * it was launched with — on T3 the live shell inside its freshness bound plus one
 * exact read by id, never an archived list:
 *
 * - exactly one match in the run's own workspace binds it;
 * - no match, on a complete read, once the creation attempt has ended (its call
 *   settled or its service was replaced) and the grace period has passed,
 *   releases the creation, and ordinary admission relaunches the role once;
 * - a partial or failed read, a match outside the workspace or more than one
 *   match keeps waiting with the reason named, and the task's coordinator may be
 *   admitted for it as for any mechanical stall.
 *
 * Releases are bounded per role (`CREATION_LOOKUP_ATTEMPTS`); past the bound the
 * task records a typed stop naming its explicit command. The coordinator's own
 * creations keep their existing lookup in the coordinator episode.
 */

export const CREATION_LOOKUP_ATTEMPTS = 3;

export type CreationLookupContext = Pick<
  Resolution,
  | "adapter"
  | "graceMs"
  | "hostAvailable"
  | "onTaskHost"
  | "store"
  | "waiting"
  | "update"
>;

export type CreationSettlement =
  | "bound"
  | "released"
  | "waiting"
  | "stopped"
  | "skipped";

type Lookup =
  | { kind: "bound"; agentId: string }
  | { kind: "absent" }
  | { kind: "unknown"; why: string }
  | { kind: "unreadable"; why: string };

const roleCommand = (role: Run["role"] | "worker"): string | null =>
  role === "reviewer"
    ? "reviewer"
    : role === "revision" || role === "worker"
      ? "worker"
      : role === "recovery"
        ? "coordinator"
        : null;

async function lookUp(
  ctx: CreationLookupContext,
  owner: Run | Task,
  binding: { id: string; taskId: string; hostId?: string | null; workspaceId: string },
): Promise<Lookup> {
  const find = ctx.adapter.findRunAgents;
  if (!find) return { kind: "unreadable", why: "this host has no run lookup" };
  let found: { id: string; workspaceId: string | null; hostConfirmed?: boolean }[];
  try {
    found = await ctx.onTaskHost(owner, () =>
      find.call(ctx.adapter, binding as unknown as Run),
    );
  } catch (error) {
    return {
      kind: "unreadable",
      why: `the lookup could not complete (${(error instanceof Error ? error.message : String(error)).slice(0, 200)})`,
    };
  }
  if (found.length === 0) return { kind: "absent" };
  const [only] = found;
  if (
    found.length === 1 &&
    only!.id &&
    only!.workspaceId === binding.workspaceId &&
    only!.hostConfirmed !== false
  )
    return { kind: "bound", agentId: only!.id };
  return {
    kind: "unknown",
    why:
      found.length > 1
        ? `the lookup found ${found.length} threads for it`
        : "the lookup found a thread outside its workspace",
  };
}

/** Releases this sweep already made for one role on this task (the per-role bound). */
function absentReleases(store: Store, taskId: string, role: string): number {
  return store
    .eventsAll(taskId)
    .filter((event) => event.kind === "creation_absent_released")
    .filter((event) => {
      try {
        return (JSON.parse(event.detail) as { role?: string }).role === role;
      } catch {
        return false;
      }
    }).length;
}

/** A stable wait naming the uncertain creation and why it is still open. */
function waitOn(
  ctx: CreationLookupContext,
  task: Task,
  role: string,
  runId: string,
  why: string,
): CreationSettlement {
  const command = roleCommand(role as Run["role"]);
  const reason = `Uncertain ${role} creation ${runId}: ${why}; Nucleus looks it up again on the next pass${command ? ` (run.start ${command} fresh replacing=${runId} resolves it now)` : ""}`;
  const current = ctx.store.task(task.id);
  const stop = current.resolution.stop;
  // Another owner's stop keeps the task's visible cause; the lookup still runs.
  if (stop && stop.fact?.subject !== runId && stop.reason !== "lifecycle")
    return "waiting";
  if (current.reason !== reason || stop?.fact?.subject !== runId)
    ctx.waiting(current, reason, "lifecycle", {
      fact: {
        code: role === "worker" ? "worker_lookup" : "creation_lookup",
        subject: runId,
      },
    });
  return "waiting";
}

function stopOn(
  ctx: CreationLookupContext,
  task: Task,
  role: string,
  runId: string,
): CreationSettlement {
  const command = roleCommand(role as Run["role"]);
  const reason = `Uncertain ${role} creation ${runId} found no thread after ${CREATION_LOOKUP_ATTEMPTS} automatic relaunches; use ${command ? `run.start ${command} fresh replacing=${runId} or ` : ""}run.release run=${runId}`;
  const current = ctx.store.task(task.id);
  if (current.reason !== reason)
    ctx.waiting(current, reason, "operator_needed", {
      fact: {
        code: role === "worker" ? "worker_lookup" : "creation_lookup",
        subject: runId,
      },
    });
  return "stopped";
}

/** Why an absent creation is not released yet, in words stable across passes. */
function pendingWhy(store: Store, binding: CreationBinding, graceMs: number): string {
  const attempt = readCreationAttempt(store, binding);
  if (!attempt) return "no thread yet, and its creation attempt is not journaled";
  if (!attempt.settlement && attempt.producerId === creationProducerId)
    return "no thread yet, and its creation call has not answered";
  const since = Date.parse(attempt.settlement?.at ?? attempt.reservedAt);
  return `no thread yet; its grace period ends at ${new Date(since + graceMs).toISOString()}`;
}

const uncertainRun = (run: Run | null | undefined): run is Run =>
  Boolean(
    run &&
      !run.released &&
      !run.agentId &&
      !run.completion &&
      ["intent", "uncertain"].includes(run.status),
  );

/**
 * Settle one run whose creation is uncertain (reviewer, revision or closeout).
 * The coordinator's recovery runs keep the coordinator episode's own lookup, and
 * a proof executor keeps its owner-activated path.
 */
export async function settleRunCreation(
  ctx: CreationLookupContext,
  task: Task,
  run: Run,
): Promise<CreationSettlement> {
  const store = ctx.store;
  // Roles with an ordinary admission that relaunches them; a proof executor and
  // the coordinator keep their own owners.
  if (
    !uncertainRun(run) ||
    !["reviewer", "revision", "closeout"].includes(run.role)
  )
    return "skipped";
  if (dispatchBlocked(task) || !run.workspaceId) return "skipped";
  if (!ctx.hostAvailable(task, run)) return "skipped";
  // Captured before the read: only an attempt that had already ended counts.
  const ended = creationTermination(store, run, ctx.graceMs);
  const lookup = await lookUp(ctx, run, run);
  const latest = store.run(run.id);
  if (!uncertainRun(latest)) return "skipped";
  const current = store.task(task.id);
  if (lookup.kind === "unreadable" || lookup.kind === "unknown")
    return waitOn(ctx, current, run.role, run.id, lookup.why);
  if (lookup.kind === "absent" && !ended)
    return waitOn(ctx, current, run.role, run.id, pendingWhy(store, run, ctx.graceMs));
  if (lookup.kind === "bound") {
    const agentId = lookup.agentId;
    store.transaction(() => {
      const fresh = store.run(run.id);
      if (!uncertainRun(fresh)) return;
      store.putRun({ ...fresh, agentId, status: "running", active: true });
      let latestTask = store.task(task.id);
      const owned = latestTask.resolution.currentRunId === run.id;
      if (run.role === "reviewer" && owned)
        latestTask = ctx.update(latestTask, {
          reviewerAgentId: agentId,
          ...(fresh.profile ? { reviewerProfile: fresh.profile } : {}),
        });
      else if (run.role === "revision" && owned && latestTask.agentId !== agentId)
        latestTask = store.update(latestTask.id, {
          agentId,
          runId: run.id,
          ...(fresh.profile && !latestTask.agentId
            ? { profile: fresh.profile }
            : {}),
          ...(latestTask.agentId && latestTask.runId && latestTask.profile
            ? {
                retiredWorkers: [
                  ...latestTask.retiredWorkers,
                  {
                    agentId: latestTask.agentId,
                    runId: latestTask.runId,
                    profile: latestTask.profile,
                    reason: `Revision ${run.id} was bound to its created thread ${agentId} by lookup`,
                  },
                ],
              }
            : {}),
        });
      else if (
        coordinative(fresh) &&
        latestTask.coordinatorGeneration === fresh.generation
      )
        latestTask = store.update(latestTask.id, { coordinatorAgentId: agentId });
      store.event(
        task.id,
        "creation_bound_by_lookup",
        JSON.stringify({ runId: run.id, role: run.role, agentId }),
      );
      ctx.waiting(store.task(task.id), threadRunningReason(run.role), "lifecycle");
    });
    return "bound";
  }
  // Absent on a complete read after the attempt ended and its grace passed.
  if (absentReleases(store, task.id, run.role) >= CREATION_LOOKUP_ATTEMPTS)
    return stopOn(ctx, current, run.role, run.id);
  store.transaction(() => {
    const fresh = store.run(run.id);
    if (!uncertainRun(fresh)) return;
    store.putRun({
      ...fresh,
      status: "superseded",
      released: true,
      active: false,
      absentProvenAt: now(),
    });
    store.deleteCredential(run.id);
    const latestTask = store.task(task.id);
    const resolution = { ...latestTask.resolution };
    if (resolution.currentRunId === run.id) resolution.currentRunId = null;
    if (resolution.stop?.fact?.subject === run.id) resolution.stop = null;
    if (resolution.incident?.runId === run.id) resolution.incident = null;
    store.update(
      latestTask.id,
      {
        resolution,
        ...(latestTask.reason === latestTask.resolution.stop?.detail
          ? { reason: `Uncertain ${run.role} creation ${run.id} produced no thread; relaunching` }
          : {}),
      },
      "creation_absent_released",
      JSON.stringify({
        runId: run.id,
        role: run.role,
        terminatedBy: ended!.terminatedBy,
      }),
    );
  });
  return "released";
}

/** Settle the initial worker's uncertain creation (its binding lives on the task row). */
export async function settleWorkerCreation(
  ctx: CreationLookupContext,
  task: Task,
): Promise<CreationSettlement> {
  const store = ctx.store;
  const runId = task.runId;
  if (!task.agentIntent || task.agentId || !runId || !task.workspaceId)
    return "skipped";
  if (dispatchBlocked(task) || !ctx.hostAvailable(task)) return "skipped";
  const binding = {
    id: runId,
    taskId: task.id,
    hostId: task.hostId,
    workspaceId: task.workspaceId,
    role: "worker" as const,
  };
  const ended = creationTermination(store, binding, ctx.graceMs);
  const lookup = await lookUp(ctx, task, binding);
  const current = store.task(task.id);
  if (
    !current.agentIntent ||
    current.agentId ||
    current.runId !== runId ||
    current.workspaceId !== task.workspaceId
  )
    return "skipped";
  if (lookup.kind === "unreadable" || lookup.kind === "unknown")
    return waitOn(ctx, current, "worker", runId, lookup.why);
  if (lookup.kind === "absent" && !ended)
    return waitOn(ctx, current, "worker", runId, pendingWhy(store, binding, ctx.graceMs));
  if (lookup.kind === "bound") {
    store.update(
      current.id,
      {
        agentId: lookup.agentId,
        phase: "working",
        reason: "Worker running",
        resolution: {
          ...current.resolution,
          stop: null,
          ...(current.resolution.incident && !current.resolution.incident.runId
            ? { incident: null }
            : {}),
        },
      },
      "creation_bound_by_lookup",
      JSON.stringify({ runId, role: "worker", agentId: lookup.agentId }),
    );
    return "bound";
  }
  if (absentReleases(store, current.id, "worker") >= CREATION_LOOKUP_ATTEMPTS)
    return stopOn(ctx, current, "worker", runId);
  store.transaction(() => {
    store.deleteCredential(runId);
    store.update(
      current.id,
      {
        agentIntent: false,
        restartRunId: runId,
        runId: null,
        phase: "dispatching",
        reason: `Uncertain worker creation ${runId} produced no thread; relaunching`,
        briefRuns: current.briefRuns.filter((item) => item.runId !== runId),
        laneDocumentRuns: (current.laneDocumentRuns ?? []).filter(
          (item) => item.runId !== runId,
        ),
        resolution: {
          ...current.resolution,
          stop: null,
          ...(current.resolution.incident && !current.resolution.incident.runId
            ? { incident: null }
            : {}),
        },
      },
      "creation_absent_released",
      JSON.stringify({ runId, role: "worker", terminatedBy: ended!.terminatedBy }),
    );
  });
  return "released";
}
