import { parseAgentId, sameCallerIdentity } from "../../shared/agent-identity";
import {
  holdsOf,
  OPERATOR_BOARD_CALLER,
  syncHoldProjection,
  type Run,
  type Task,
  type TaskNextExplicitCommand,
} from "../../shared/contracts";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import type { QueueOperation } from "../../shared/operations";
import type {
  ExplicitResolution,
  ResolutionWarningId,
  TaskControlTask,
} from "../../shared/schema/task-control";
import { PLANNER_ONLY_WARNINGS } from "../../shared/schema/resolution-warnings";
import {
  TASK_PROGRESSING_REASON,
  isWaitingTaskStop,
  stopNamesRun,
} from "../../shared/task-stop";
import type { ResponsibleThreadReason } from "../../shared/responsible-thread";
import type { Engine } from "../engine";
import { recordResultApplied, resultApplied } from "../intake/applied-result";
import { signalProcessGroupByLeader } from "../machine/process-group";
import {
  reattachRefusal,
  reattachStoredTaskCheckout,
} from "../git/checkout-reattach";
import {
  responsiblePickable,
  type ResponsibleCandidate,
} from "../questions/responsible-thread-cache";
import {
  dispatchedBy,
  registeredAs,
} from "../questions/responsible-thread-resolver";
import { closeEscalationFollowups } from "../questions/ladder/continuation";
import {
  unboundDispatchWorkspace,
  WORKSPACE_INTENT_RELEASED,
  workspaceIntentReleasePatch,
  workspaceLookupStop,
} from "../recovery/workspace-lookup";
import { plannerEscalations } from "../questions/ladder/records";
import { blockingRecoveryEffects } from "../recovery/recovery-effects";
import { plannerIdMatches } from "../recovery/task-reasons";
import { reviewPublicationKey } from "../review/review-publication";
import { digest, now, type Store } from "../store/store";
import {
  creationProducerId,
  readCreationAttempt,
} from "../store/store-task-funnel";
import { threadServesAnotherTask } from "../workspaces/thread-ownership";
import { collectOwnerVerbFacts, ownerPendingEffects } from "./owner-verbs";
import { splitOwnerEffectKey } from "./owner-effects";

import {
  messageSendPlan,
  phaseSetPlan,
  preflightExplicitRunStart,
  resolveMessageTarget,
  runStartPlan,
} from "./explicit-run-start";
import {
  closeoutNowPlan,
  mergeNowPlan,
  OPERATOR_ONLY_WARNINGS,
  preflightExplicitIntegration,
  turnReleasePlan,
  turnTakePlan,
} from "./explicit-integration";

type Source = "operator_board" | "project_planner" | "coordinator";
export type ExplicitWarning = { id: ResolutionWarningId; text: string };
export type ExplicitChange = { patch?: Partial<Task>; before: unknown };
export type ExplicitFinishResult = {
  issues: string[];
  runId?: string;
  delivery?: "delivered" | "queued" | "unknown";
};
export type ExplicitPlan = {
  warnings: ExplicitWarning[];
  apply(): ExplicitChange;
  finish?(): Promise<ExplicitFinishResult>;
};
type Warning = ExplicitWarning;
type Plan = ExplicitPlan;

const missing = (kind: string, id: string): never => {
  throw Error(`No current ${kind} ${id} belongs to this task`);
};
const unfinished = (operation: QueueOperation) =>
  ["pending", "running", "needs_attention"].includes(operation.state);

function settleOperation(
  store: Store,
  operation: QueueOperation,
  reason: string,
) {
  const at = now();
  store.putOperation({
    ...operation,
    state: "failed",
    settledAt: at,
    diagnostic: reason,
    settlement: {
      id: operation.id,
      inputHash: operation.inputHash,
      attempt: operation.attempts,
      intentAt: operation.effect?.intentAt ?? operation.startedAt,
      evidence: reason,
      kind: "superseded",
    },
    effect: operation.effect
      ? {
          ...operation.effect,
          status: "reconciled",
          result: reason.slice(0, 2000),
          resultAt: at,
        }
      : null,
  });
}

/**
 * The reasons that make a confirmed candidate one of the project's planners:
 * registered, dispatching or owning its tasks (a task's own recorded planner and
 * its origin thread are dispatchers by construction), or named on the project.
 * A thread that only works in a checkout acts only while it is the routing pick.
 */
const PLANNER_REASONS: ReadonlySet<ResponsibleThreadReason> = new Set([
  "registered-planner",
  "dispatcher",
  "registered-agent",
]);

export type PlannerAuthority = { ok: true } | { ok: false; reason: string };

/**
 * Planner authority comes from the caller's authenticated identity matching a
 * confirmed responsible planner of the task's project (Tom, 2026-11-19: no
 * singleton planners). Host observation only decides delivery, so an
 * `unverified` planner (its host not yet proven after a roll) still holds
 * authority; an `unroutable` one never does.
 *
 * Registration is a durable fact, so it needs no live read: the project's
 * registered planner and the task's own recorded or origin planner hold
 * authority from the stored record and the caller's identity alone, whatever
 * state the hosts are in.
 *
 * Every other planner's candidacy is decided by its own host's inventory:
 * another host that is offline or unread cannot add or remove it.
 *
 * - When this call's read answered for the caller's host, any planner on it
 *   holds authority (registered, dispatching or named), and the routing pick.
 * - When it did not (the host is offline or unread, or an invalidation such as
 *   the caller's own activity or a notice to it discarded the read), that
 *   host's last finished read within `plannerAuthorityMaxAgeMs` stands in, for
 *   the registered planner or a dispatcher only, each re-checked against the
 *   current registry.
 *
 * Every refusal names its reason, so a transient read failure reads differently
 * from a caller that is not a planner.
 */
export async function plannerAuthority(
  engine: Engine,
  task: Task,
  caller: string,
  queue = false,
): Promise<PlannerAuthority> {
  const project = queue
    ? engine.store.queueProject()
    : engine.store.projectFor(
        task.repoPath,
        normalizeRepositoryOrigin(task.repository ?? ""),
      );
  if (!project)
    return {
      ok: false,
      reason: queue
        ? "no Nucleus project is registered"
        : "no project holds this task's repository",
    };
  const isCaller = (candidate: ResponsibleCandidate) =>
    responsiblePickable(candidate) &&
    plannerIdMatches(
      candidate.agentId,
      caller,
      candidate.hostId,
      engine.legacyPaseoHostId(),
    );
  const notPlanner = {
    ok: false as const,
    reason: `this caller is not one of them: it is not a responsible planner for project ${project.name}`,
  };
  const callerRef = parseAgentId(caller);
  const callerHost = callerRef?.hostId ?? engine.legacyPaseoHostId() ?? null;
  const callerNative = callerRef?.nativeAgentId ?? caller;
  if (
    callerHost &&
    (registeredAs(project.planner?.agentId, callerNative, callerHost) ||
      (!queue && dispatchedBy(task, callerNative, callerHost)))
  )
    return { ok: true };
  const read = await engine.resolution.responsibleThread(project);
  const isPick = (candidate: ResponsibleCandidate) =>
    sameCallerIdentity(
      read.thread?.agentId,
      candidate.agentId,
      read.thread?.hostId,
      candidate.hostId,
    );
  if (read.confirmed && callerHost && read.readHosts.includes(callerHost))
    return read.shortlist.some(
      (candidate) =>
        isCaller(candidate) &&
        (isPick(candidate) ||
          candidate.reasons.some((reason) => PLANNER_REASONS.has(reason))),
    )
      ? { ok: true }
      : notPlanner;
  if (!callerHost) {
    // A bare caller with no host to read it on: only a complete read decides.
    if (read.confirmed && !read.incomplete)
      return read.shortlist.some(
        (candidate) =>
          isCaller(candidate) &&
          (isPick(candidate) ||
            candidate.reasons.some((reason) => PLANNER_REASONS.has(reason))),
      )
        ? { ok: true }
        : notPlanner;
    return {
      ok: false,
      reason: `the responsible-planner read for project ${project.name} is unconfirmed or incomplete, and this caller names no host`,
    };
  }
  const last = engine.resolution.lastConfirmedResponsible(
    project.key,
    callerHost,
  );
  if (last) {
    const tasks =
      engine.resolution.responsibleThreads.taskIndex().byProject.get(
        project.key,
      ) ?? [];
    const accepted = last.candidates.some((candidate) => {
      if (!isCaller(candidate)) return false;
      const native =
        parseAgentId(candidate.agentId)?.nativeAgentId ?? candidate.agentId;
      return (
        (candidate.reasons.includes("registered-planner") &&
          registeredAs(project.planner?.agentId, native, candidate.hostId)) ||
        (candidate.reasons.includes("dispatcher") &&
          tasks.some((owned) => dispatchedBy(owned, native, candidate.hostId)))
      );
    });
    return accepted ? { ok: true } : notPlanner;
  }
  const state = engine.resolution.responsibleHostState(callerHost);
  if (state === "unregistered")
    return {
      ok: false,
      reason: `this caller is not one of them: its host ${callerHost} is not a registered host`,
    };
  const hostState =
    state === "offline"
      ? `is incomplete (host ${callerHost} offline)`
      : read.unreadHosts.includes(callerHost)
        ? `is incomplete (host ${callerHost} unread)`
        : `is unconfirmed (host ${callerHost} not read in this call)`;
  return {
    ok: false,
    reason: `the responsible-planner read for project ${project.name} ${hostState}, and no read of that host finished in the last ${Math.round(
      engine.resolution.plannerAuthorityMaxAgeMs / 60_000,
    )} minutes`,
  };
}

/** Whether the caller holds planner authority for this task; `plannerAuthority` says why not. */
export async function livePlannerMatches(
  engine: Engine,
  task: Task,
  caller: string,
  queue = false,
): Promise<boolean> {
  return (await plannerAuthority(engine, task, caller, queue)).ok;
}

/** Names the real reason an explicit command's caller lacks authority. */
function explicitAuthorityRefusal(
  task: Task,
  caller: string | undefined,
  reason?: string,
): string {
  const who = task.critical
    ? "its live responsible planner or the operator board"
    : "this task's coordinator, its live responsible planner or the operator board";
  const why = caller
    ? (reason ?? "this caller is not one of them")
    : "no authenticated caller was given";
  return task.critical
    ? `A critical task requires ${who}; ${why}`
    : `Explicit resolution requires ${who}; ${why}`;
}

async function authority(
  engine: Engine,
  task: Task,
  caller: string | undefined,
): Promise<Source> {
  if (caller === OPERATOR_BOARD_CALLER) return "operator_board";
  const planner = caller
    ? await plannerAuthority(engine, task, caller)
    : null;
  if (planner?.ok) return "project_planner";
  const recovery = task.resolution.recovery;
  const run = recovery?.runId ? engine.store.run(recovery.runId) : null;
  if (
    !task.critical &&
    run &&
    run.taskId === task.id &&
    run.role === "recovery" &&
    !run.released &&
    !run.completion &&
    sameCallerIdentity(
      run.agentId,
      caller,
      run.hostId ?? task.hostId,
      engine.legacyPaseoHostId(),
    )
  )
    return "coordinator";
  throw Error(
    explicitAuthorityRefusal(
      task,
      caller,
      planner && !planner.ok ? planner.reason : undefined,
    ),
  );
}

/** Each command reads and applies its own records within the same transaction. */
export async function resolveExplicitly(
  engine: Engine,
  input: ExplicitResolution,
  describeNext: (task: Task) => string,
): Promise<TaskControlTask> {
  const store = engine.store;
  const id = store.resolveTaskId(input.taskId);
  const before = store.task(id);
  const source = await authority(engine, before, input.caller);
  const messageTarget =
    input.action === "message.send"
      ? await resolveMessageTarget(engine, before, input.role)
      : null;
  // Every preflight, plan, apply and finish reads host and forge ports through
  // the routed adapter, which serves only the ambient host. Outside a host
  // context it falls back to the unbound adapter, which carries no forge ports,
  // so each phase runs on the task's own host.
  const onHost = <T>(fn: () => T): T => engine.onTaskHost(before, fn);
  const runStartPreflight =
    input.action === "run.start" &&
    input.version === before.version &&
    !before.removedAt
      ? await onHost(() => preflightExplicitRunStart(engine, before, input))
      : undefined;
  const integrationPreflight =
    (input.action === "turn.take" ||
      input.action === "turn.release" ||
      input.action === "merge.now" ||
      input.action === "closeout.now") &&
    input.version === before.version &&
    !before.removedAt
      ? await onHost(() => preflightExplicitIntegration(engine, before, input))
      : undefined;
  const result = store.transaction(() => {
    const task = store.task(id);
    const reply = (
      status: "stale" | "warnings",
      warnings: Warning[] = [],
    ): { task: Task; status: typeof status; warnings: Warning[] } => ({
      task,
      status,
      warnings,
    });
    if (input.version !== task.version) return reply("stale");
    if (task.removedAt) throw Error("Task was removed from the queue");
    const releasing =
      input.action === "run.release" ? store.run(input.run) : null;
    const plannerOnly = input.accept.filter((id) => PLANNER_ONLY_WARNINGS.has(id));
    if (source === "coordinator" && plannerOnly.length)
      throw Error(
        `Only the live responsible planner or operator board can accept ${plannerOnly.join(", ")}`,
      );
    if (
      source !== "operator_board" &&
      input.accept.some((id) => OPERATOR_ONLY_WARNINGS.has(id))
    )
      throw Error("Only the operator board can accept unverified_merge");

    const plan = engine.onTaskHost(task, () =>
      input.action === "run.release"
        ? releasePlan(engine, task, input)
        : input.action === "record.clear"
          ? clearPlan(engine, task, input)
          : input.action === "run.start"
            ? runStartPlan(engine, task, input, runStartPreflight)
            : input.action === "phase.set"
              ? phaseSetPlan(engine, task, input)
              : input.action === "message.send"
                ? messageSendPlan(engine, task, input, messageTarget!)
                : input.action === "turn.take"
                  ? turnTakePlan(engine, task, input)
                  : input.action === "turn.release"
                    ? turnReleasePlan(engine, task, input)
                    : input.action === "merge.now"
                      ? mergeNowPlan(engine, task, input, integrationPreflight)
                      : closeoutNowPlan(
                          engine,
                          task,
                          input,
                          integrationPreflight,
                        ),
    );
    if (plan.warnings.some((warning) => !input.accept.includes(warning.id)))
      return reply("warnings", plan.warnings);

    const { patch, before } = engine.onTaskHost(task, () => plan.apply());
    const {
      caller,
      accept,
      reason,
      taskId: _identity,
      version,
      action,
      ...args
    } = input;
    const saved = store.update(
      task.id,
      patch ?? {},
      "owner_resolution",
      JSON.stringify({
        command: action,
        arguments: args,
        version,
        caller,
        source,
        warnings: plan.warnings,
        accepted: plan.warnings
          .filter((warning) => accept.includes(warning.id))
          .map((warning) => warning.id),
        reason,
        before,
      }),
    );
    return {
      task: saved,
      status: "applied" as const,
      warnings: plan.warnings,
      finish: plan.finish,
      wake:
        (input.action === "record.clear" && isRecoveryRecordKind(input.kind)) ||
        releasing?.role === "recovery",
    };
  });
  const finished =
    "finish" in result && result.finish
      ? await onHost(() => result.finish!())
      : undefined;
  const latestTask = result.status === "applied" ? store.task(id) : result.task;
  const next = describeNext(latestTask);
  const deliveryNote = finished?.delivery
    ? `Message delivery: ${finished.delivery}.`
    : "";
  if ("wake" in result && result.wake) engine.scheduleLifecycleFollowUp(id);
  return {
    ...latestTask,
    explicitResolution: {
      status: result.status,
      warnings: result.warnings,
      ...(finished?.runId ? { runId: finished.runId } : {}),
      ...(finished?.delivery ? { delivery: finished.delivery } : {}),
      next: [
        result.status === "stale"
          ? `Task is now at version ${latestTask.version}. Repeat with that version.`
          : "",
        deliveryNote,
        ...(finished?.issues ?? []),
        next,
      ]
        .filter(Boolean)
        .join(" "),
    },
  };
}

/**
 * The engine ports the ordinary release plan needs. Narrow deliberately, so the
 * same plan serves an owner `run.release` and the sweep's own release of a
 * provably dead participant (Spec 068 §3; nucleus#1552).
 */
export type ReleasePlanContext = Pick<Engine, "store" | "host" | "withHost">;

type RecoveryEpisode = NonNullable<Task["resolution"]["recovery"]>;
type RecordKind = Extract<
  ExplicitResolution,
  { action: "record.clear" }
>["kind"];
type RecoveryRecordKind = Extract<
  RecordKind,
  "recovery" | "attention" | "run_pointer"
>;

function isRecoveryRecordKind(kind: RecordKind): kind is RecoveryRecordKind {
  return kind === "recovery" || kind === "attention" || kind === "run_pointer";
}

function pendingRecoveryWarnings(
  store: Store,
  task: Task,
  episode: RecoveryEpisode,
): Warning[] {
  const action = episode.action;
  if (action?.status !== "pending") return [];
  return coordinatorClaimWarnings(store, task, action.runId, action.eventId);
}

function coordinatorClaimWarnings(
  store: Store,
  task: Task,
  runId: string,
  eventId: string,
): Warning[] {
  const claim = JSON.stringify([task.id, runId, eventId]);
  if (
    resultApplied(store, task.id, runId) ||
    !store
      .eventsAll(task.id)
      .some(
        (event) =>
          event.kind === "run_result_applying" && event.detail === claim,
      )
  )
    return [];
  return [
    {
      id: "effect_may_land",
      text: `Coordinator action ${eventId} already started and its effect may still land.`,
    },
  ];
}

/** Close one episode and the mechanical records that identify it. */
function recoveryEpisodeSettlement(
  store: Store,
  task: Task,
  episode: RecoveryEpisode,
  reason: string,
): Partial<Task> {
  const { incident, stop } = task.resolution;
  const events = store.eventsAll(task.id);
  const causes = ["recovery-pending", "coordinator-refused"].map((cause) =>
    digest(`${cause}:${task.id}:${episode.id}`),
  );
  const escalations = plannerEscalations(events).filter(
    (item) =>
      causes.includes(item.cause) &&
      !item.decisionId &&
      !events.some(
        (event) =>
          event.kind === "planner_escalation_answered" &&
          event.detail.startsWith(`${item.id}:`),
      ),
  );
  for (const item of escalations) {
    if (item.answered) continue;
    store.event(
      task.id,
      "planner_escalation_resolved",
      `${item.id}: ${reason}`,
    );
    closeEscalationFollowups(store, task.id, item.id);
  }

  const action = episode.action;
  if (action?.status === "pending") {
    // The action's run may already be detached. Fence an in-flight finish
    // only when its immutable report (or the episode binding) identifies it.
    const run = store.run(action.runId);
    if (
      run?.taskId === task.id &&
      run.role === "recovery" &&
      (run.completion
        ? run.completion.eventId === action.eventId
        : episode.runId === run.id) &&
      !resultApplied(store, task.id, run.id)
    ) {
      store.recordVerbOutcome(
        task.id,
        action.coordinatorAction?.verb ?? "retired_recovery_action",
        "refused",
        "coordinator",
        { coordinatorRun: run.id, reason: reason.slice(0, 600) },
        `coordinator:${action.eventId}`,
      );
      store.event(task.id, "coordinator_action_refused", action.eventId);
      recordResultApplied(store, task.id, run.id);
    }
  }
  const incidentRun = incident?.runId ? store.run(incident.runId) : null;
  const independentLiveRun =
    incident?.runId &&
    incident.runId !== episode.runId &&
    (incidentRun
      ? !incidentRun.released
      : task.runId === incident.runId && !task.completion);
  const ownsIncident =
    incident && incident.id === episode.incidentId && !independentLiveRun;
  const ownsStop =
    stop &&
    !stop.holderAgentId &&
    ((ownsIncident &&
      stop.incidentId === incident.id &&
      ["operator_needed", "lifecycle", "run_stalled"].includes(stop.reason)) ||
      (stop.fact?.code === "escalation" &&
        escalations.some((item) => item.id === stop.fact?.subject)));
  return {
    ...(ownsStop && task.reason === stop.detail
      ? { reason: TASK_PROGRESSING_REASON }
      : {}),
    resolution: {
      ...task.resolution,
      recoveryActive: false,
      recovery: {
        ...episode,
        runId: null,
        status: "resolved",
        ...(action?.status === "pending"
          ? { action: { ...action, status: "refused" as const, reason } }
          : {}),
      },
      incident:
        ownsIncident && incident.status !== "resolved"
          ? { ...incident, status: "resolved", updatedAt: now() }
          : incident,
      stop: ownsStop ? null : stop,
      attention:
        ownsIncident && (!stop || ownsStop) ? false : task.resolution.attention,
    },
  };
}

function releaseCoordinatorBinding(
  store: Store,
  task: Task,
  run: Run,
  reason: string,
): Partial<Task> {
  store.putRun({
    ...run,
    active: false,
    released: true,
    explicitlyReleasedAt: run.explicitlyReleasedAt ?? now(),
    status: run.completion ? run.status : "superseded",
  });
  const episode = task.resolution.recovery;
  const patch =
    episode?.runId === run.id
      ? recoveryEpisodeSettlement(store, task, episode, reason)
      : {};
  if (run.completion) recordResultApplied(store, task.id, run.id);
  const resolution = { ...(patch.resolution ?? task.resolution) };
  if (resolution.currentRunId === run.id) resolution.currentRunId = null;
  if (stopNamesRun(task, run.id) && !task.resolution.stop?.holderAgentId) {
    if (task.reason === task.resolution.stop?.detail)
      patch.reason = TASK_PROGRESSING_REASON;
    resolution.stop = null;
  }
  return { ...patch, resolution };
}

function recoveryRecordPlan(
  store: Store,
  task: Task,
  kind: RecoveryRecordKind,
  id: string,
  reason: string,
): Plan | null {
  const r = task.resolution;
  const episode = r.recovery;
  const plain = (
    before: unknown,
    fields: Partial<Task["resolution"]>,
  ): Plan => ({
    warnings: [],
    apply: () => ({ before, patch: { resolution: { ...r, ...fields } } }),
  });
  switch (kind) {
    case "recovery": {
      if (!episode)
        return id === task.id &&
          r.recoveryActive &&
          !store
            .runs(task.id)
            .some((run) => run.role === "recovery" && !run.released)
          ? plain(true, { recoveryActive: false })
          : null;
      const run = episode.runId ? store.run(episode.runId) : null;
      const bound = run?.taskId === task.id && run.role === "recovery";
      if (
        episode.id !== id ||
        (episode.status === "resolved" &&
          !r.recoveryActive &&
          episode.action?.status !== "pending" &&
          (!episode.runId || bound))
      )
        return null;
      if (bound && !run.released) return null;
      return {
        warnings: pendingRecoveryWarnings(store, task, episode),
        apply: () => ({
          before: episode,
          patch: recoveryEpisodeSettlement(store, task, episode, reason),
        }),
      };
    }
    case "attention":
      return id === task.id &&
        r.attention &&
        !r.stop &&
        !task.originError &&
        !r.externalMergePreAttention &&
        !r.unreviewedMerge &&
        (!r.incident || r.incident.status === "resolved") &&
        (!episode ||
          (episode.status === "resolved" &&
            episode.action?.status !== "pending")) &&
        !r.recoveryActive &&
        !["blocked", "error", "needs_attention"].includes(task.phase) &&
        (!task.runId ||
          Boolean(task.completion) ||
          task.agentActive === false) &&
        !store.runs(task.id).some((run) => !run.released) &&
        !plannerEscalations(store.eventsAll(task.id)).some(
          (item) => !item.answered,
        )
        ? plain(true, { attention: false })
        : null;
    case "run_pointer":
      return r.currentRunId === id && task.runId !== id && !store.run(id)
        ? plain(id, { currentRunId: null })
        : null;
  }
}

/** Every release plan and its `next` offers admit the same release target. */
export function releaseRefusal(
  store: Store,
  task: Task,
  runId: string,
  archive?: boolean,
): string | null {
  const run = store.run(runId);
  if (run ? run.taskId !== task.id : task.runId !== runId)
    return `No current run ${runId} belongs to this task`;
  if (
    run?.role === "recovery" &&
    run.released &&
    !archive &&
    task.resolution.recovery?.runId !== runId
  )
    return `No current coordinator binding for run ${runId} belongs to this task`;
  const attempt = readCreationAttempt(
    store,
    run ?? {
      id: runId,
      taskId: task.id,
      hostId: task.hostId,
      workspaceId: task.workspaceId,
      role: "worker",
    },
  );
  // The journal covers the live call before a stop is written. The host can
  // still owe a reply after the call ends with unknown delivery.
  if (
    (attempt?.producerId === creationProducerId && !attempt.settlement) ||
    (task.resolution.stop?.fact?.code === "creation_in_flight" &&
      task.resolution.stop.fact.subject === runId)
  )
    return `Creation for run ${runId} may still be answered by the host. Wait for its outcome before releasing this run.`;
  return null;
}

export function recoverySettlementOffers(
  store: Store,
  task: Task,
  runs: Run[],
): TaskNextExplicitCommand[] {
  const base = { taskId: task.id, version: task.version };
  const r = task.resolution;
  const targets = [
    {
      kind: "recovery",
      id: r.recovery?.id ?? task.id,
      note: r.recovery
        ? `Settle recovery episode ${r.recovery.id} and its pending action.`
        : "Clear the orphaned recovery flag.",
    },
    {
      kind: "attention",
      id: task.id,
      note: "Clear the orphaned attention flag.",
    },
    {
      kind: "run_pointer",
      id: r.currentRunId,
      note: "Clear the pointer to the missing current run.",
    },
  ] satisfies Array<{
    kind: RecoveryRecordKind;
    id: string | null;
    note: string;
  }>;
  const offers: TaskNextExplicitCommand[] = [];
  for (const { kind, id, note } of targets) {
    if (!id) continue;
    const plan = recoveryRecordPlan(store, task, kind, id, "");
    if (plan)
      offers.push({
        action: "record.clear",
        args: { action: "record.clear", ...base, kind, id },
        fill: ["reason"],
        note,
        warnings: plan.warnings.map((warning) => warning.id),
      });
  }
  for (const run of runs) {
    if (run.role !== "recovery" || releaseRefusal(store, task, run.id)) continue;
    offers.push({
      action: "run.release",
      args: { action: "run.release", ...base, run: run.id },
      fill: ["reason"],
      note: `Release coordinator run ${run.id} and settle its matching recovery binding.`,
      warnings: releaseWarnings(store, task, run.id).map(
        (warning) => warning.id,
      ),
    });
  }
  return offers;
}

function releasedRunLive(task: Task, run: ReturnType<Store["run"]>): boolean {
  return run
    ? !run.released &&
        (run.active !== false ||
          ["running", "intent", "uncertain"].includes(run.status))
    : task.agentActive !== false || task.agentIntent;
}

/**
 * The warnings a `run.release` of this run names, read from the stored run, the
 * task and the run's host process alone. `next` lists them as the command's
 * expected warnings (papercut ee6e634c).
 */
export function releaseWarnings(
  store: Store,
  task: Task,
  runId: string,
): Warning[] {
  const run = store.run(runId);
  const completion = run ? run.completion : task.completion;
  const process = store.hostRun(runId);
  const warnings: Warning[] = [];
  if (releasedRunLive(task, run) || process?.state === "running")
    warnings.push({
      id: "live_turn",
      text: "This run may have a live turn. Stopping a worker may lose uncommitted changes.",
    });
  if (!completion && !run?.released)
    warnings.push({
      id: "unreported_result",
      text:
        run?.role === "reviewer" && run.agentId && !run.exhaustionReason
          ? "Only this reviewer's first verdict at the current exact head can still be accepted."
          : "Any later report from this run will be refused.",
    });
  if (run?.role === "recovery") {
    const episode = task.resolution.recovery;
    if (episode?.runId === runId && episode.action?.status === "pending")
      warnings.push(...pendingRecoveryWarnings(store, task, episode));
    else if (completion)
      warnings.push(...coordinatorClaimWarnings(store, task, runId, completion.eventId));
  }
  return warnings;
}

export function releasePlan(
  engine: ReleasePlanContext,
  task: Task,
  input: Extract<ExplicitResolution, { action: "run.release" }>,
): Plan {
  const store = engine.store;
  const refusal = releaseRefusal(store, task, input.run, input.archive);
  if (refusal) throw Error(refusal);
  const run = store.run(input.run);
  const initial = !run;
  const agentId = run ? run.agentId : task.agentId;
  const hostId = run?.hostId ?? task.hostId;
  const completion = run ? run.completion : task.completion;
  const live = releasedRunLive(task, run);
  const process = store.hostRun(input.run);
  const warnings = releaseWarnings(store, task, input.run);
  const activity = run ? run.participantActivity : task.participantActivity;
  const stall = task.resolution.stalledTurnStop;
  const turnId =
    activity?.runId === input.run && activity.agentId === agentId
      ? activity.turnId
      : null;
  const recordedTurn =
    turnId ??
    (stall?.runId === input.run && stall.agentId === agentId
      ? stall.turnId
      : null);

  return {
    warnings,
    apply() {
      const patch: Partial<Task> =
        run?.role === "recovery"
          ? releaseCoordinatorBinding(store, task, run, input.reason)
          : {};
      const resolution = patch.resolution ?? { ...task.resolution };
      patch.resolution = resolution;
      if (run && run.role !== "recovery") {
        for (const delivery of run.reviewDeliveries ?? []) {
          if (delivery.status !== "reserved" && delivery.status !== "uncertain")
            continue;
          const operation = store.operation(delivery.operationId);
          if (operation?.taskId === task.id && unfinished(operation))
            settleOperation(store, operation, input.reason);
        }
        store.putRun({
          ...run,
          active: false,
          released: true,
          explicitlyReleasedAt: now(),
          status: run.completion ? "finished" : "superseded",
          reviewDeliveries: run.reviewDeliveries?.map((delivery) =>
            delivery.status === "reserved" || delivery.status === "uncertain"
              ? {
                  ...delivery,
                  status: "refused",
                  evidence: input.reason.slice(0, 2000),
                  observedAt: now(),
                }
              : delivery,
          ),
          reviewContinuation: null,
        });
      }
      if (!run) store.deleteCredential(input.run);
      if (task.runId === input.run)
        Object.assign(patch, {
          ...(!completion ? { runId: null, agentId: null } : {}),
          agentIntent: false,
          agentActive: false,
        });
      if (resolution.currentRunId === input.run && !completion) {
        resolution.currentRunId = null;
        if (run?.role === "reviewer") {
          resolution.reviewerAgentId = null;
          resolution.reviewerProfile = null;
        }
      }
      if (resolution.restartSlotHold?.fromRunId === input.run)
        resolution.restartSlotHold = null;
      if (run?.role !== "recovery" && stopNamesRun(task, input.run)) {
        if (task.reason === task.resolution.stop?.detail)
          patch.reason = TASK_PROGRESSING_REASON;
        resolution.stop = null;
      }
      return { patch, before: run ?? { id: input.run, agentId, completion } };
    },
    async finish() {
      const issues: string[] = [];
      const attempt = async (label: string, fn: () => unknown) => {
        try {
          await fn();
          return true;
        } catch (error) {
          issues.push(
            `${label} could not be confirmed: ${String(error).slice(0, 500)}.`,
          );
          return false;
        }
      };
      // Spec 068 §4: a release settles its run's custody of the checkout, so the
      // same reattach step runs here and reports why a detached checkout stayed
      // detached. The commit never moves.
      const reattach = await reattachStoredTaskCheckout(
        store,
        task.id,
        run?.id ?? input.run,
      );
      const reattachRefused = reattachRefusal(reattach);
      if (reattachRefused)
        issues.push(`Checkout reattach: ${reattachRefused}.`);
      if (process?.pid && process.processGroupId && process.startIdentity) {
        await attempt("Process-group stop", () => {
          signalProcessGroupByLeader(
            process.processGroupId!,
            process.pid!,
            process.startIdentity!,
            "SIGTERM",
          );
        });
      }
      if (agentId && (live || input.archive)) {
        const current = store.task(task.id);
        // Stop the released turn without dropping the retained worker binding.
        const releasedRetainedTurn =
          current.runId === task.runId &&
          (initial ||
            (run?.role === "revision" &&
              task.resolution.currentRunId === run.id));
        if (
          (current.agentId === agentId && !releasedRetainedTurn) ||
          threadServesAnotherTask(store, current, agentId)
        )
          return {
            issues: [
              ...issues,
              "Another live assignment still owns this thread.",
            ],
          };
        const onHost = async () => {
          if (live) {
            const stopped = await attempt("Turn cancellation", () => {
              if (!recordedTurn)
                throw Error("The released run has no recorded turn ID");
              return engine.host.stopAgentTurn(agentId, recordedTurn, {
                exact: true,
              });
            });
            if (!stopped) return;
          }
          if (!input.archive) return;
          const latest = store.task(task.id);
          if (
            latest.agentId === agentId ||
            threadServesAnotherTask(store, latest, agentId)
          ) {
            issues.push(
              "The task still depends on this thread, so it remains available.",
            );
            return;
          }
          await attempt("Thread archive", () =>
            engine.host.archiveAgent(agentId),
          );
        };
        await attempt("Host contact", () =>
          hostId ? engine.withHost(hostId, onHost) : onHost(),
        );
      }
      return { issues };
    },
  };
}

function clearPlan(
  engine: Engine,
  task: Task,
  input: Extract<ExplicitResolution, { action: "record.clear" }>,
): Plan {
  const { id, kind } = input;
  const store = engine.store;
  const r = task.resolution;
  if (isRecoveryRecordKind(kind)) {
    const plan = recoveryRecordPlan(store, task, kind, id, input.reason);
    if (plan) return plan;
    if (kind === "recovery" && r.recovery?.id === id && r.recovery.runId) {
      const run = store.run(r.recovery.runId);
      if (run?.taskId === task.id && run.role === "recovery" && !run.released)
        throw Error(
          `Coordinator run ${run.id} still owns recovery ${id}. Use run.release run=${run.id}.`,
        );
    }
    return missing(kind, id);
  }
  const stop = r.stop;
  const patch = (
    before: unknown,
    fields: Partial<Task>,
    warnings: Warning[] = [],
  ): Plan => ({ warnings, apply: () => ({ before, patch: fields }) });
  const clearStop = { stop: null };
  const clearStopPatch = {
    resolution: { ...r, ...clearStop },
    reason: TASK_PROGRESSING_REASON,
  };
  const ownerWarning = (owner: string | null): Warning[] =>
    owner && owner !== input.caller
      ? [{ id: "hold_owner", text: `This hold belongs to ${owner}.` }]
      : [];
  switch (kind) {
    case "stop":
      if (stop?.since === id) return patch(stop, clearStopPatch);
      break;
    case "wait":
      if (task.prerequisiteWait?.id === id && !task.prerequisiteWait.releasedAt)
        return patch(task.prerequisiteWait, { prerequisiteWait: null });
      if (stop?.since === id && isWaitingTaskStop(stop.reason))
        return patch(stop, clearStopPatch);
      break;
    case "hold": {
      const holds = { ...holdsOf(task) };
      if (id !== "dispatch" && id !== "merge") break;
      const hold = holds[id];
      if (!hold) break;
      delete holds[id];
      return patch(hold, syncHoldProjection(holds), ownerWarning(hold.owner));
    }
    case "incident":
      if (r.incident?.id === id)
        return patch(r.incident, { resolution: { ...r, incident: null } });
      break;
    case "host_wait":
      if (r.hostWait?.hostId === id)
        return patch(r.hostWait, {
          resolution: {
            ...r,
            hostWait: null,
            ...(stop?.reason === "host_unavailable" ? clearStop : {}),
          },
          ...(stop?.reason === "host_unavailable"
            ? { reason: TASK_PROGRESSING_REASON }
            : {}),
        });
      // Spec 069 §3: a host wait is worked out from the host's health when read;
      // no record is stored to clear, and it ends when the host reconnects.
      if (id === task.hostId && engine.inFlightHostWait(task))
        throw Error(
          `The host wait on ${id} is read from the host's health, not stored on the task; it clears when the host reconnects, and there is no record to clear`,
        );
      break;
    case "owner_stop":
      if (
        r.ownerStop &&
        (r.ownerStop.operationId ?? r.ownerStop.recordedAt) === id
      ) {
        const ownerStop = r.ownerStop;
        const warnings = ownerWarning(ownerStop.caller);
        if (ownerStop.cancellations.some((item) => item.status !== "settled"))
          warnings.push({
            id: "effect_may_land",
            text: "A requested cancellation may still take effect.",
          });
        return patch(
          ownerStop,
          { resolution: { ...r, ownerStop: null } },
          warnings,
        );
      }
      break;
    case "deferred_verb":
      if (r.deferredVerb?.at === id)
        return patch(r.deferredVerb, {
          resolution: { ...r, deferredVerb: null },
        });
      break;
    case "escalation": {
      const escalations = plannerEscalations(store.eventsAll(task.id));
      const escalation = escalations.find(
        (item) => item.id === id && !item.answered,
      );
      if (!escalation) break;
      return {
        warnings: [],
        apply() {
          store.event(
            task.id,
            "planner_escalation_resolved",
            `${id}: ${input.reason}`,
          );
          closeEscalationFollowups(store, task.id, id);
          return {
            before: escalation,
            patch:
              stop?.fact?.code === "escalation" && stop.fact.subject === id
                ? clearStopPatch
                : undefined,
          };
        },
      };
    }
    case "effect":
      return clearEffect(engine, task, id, input.reason);
    case "workspace_intent":
      // Spec 068 batch A: release an uncertain dispatch workspace creation
      // without a proof. The task returns to queued and ordinary dispatch
      // creates or binds the same branch and worktree. Only the lookup's own
      // stop (or a lifecycle wait) clears with it; another owner's stop is
      // named and refused, so a hold, escalation, budget or host wait stays.
      if (id === task.branch && unboundDispatchWorkspace(task)) {
        const ownStop =
          !stop || stop.reason === "lifecycle" || workspaceLookupStop(stop);
        if (!ownStop)
          throw Error(
            `The task's ${stop.reason} stop is not the workspace lookup's and stays: ${stop.detail}. Settle that stop first (record.clear kind=stop id=${stop.since} clears it), then release the workspace intent`,
          );
        const warnings: Warning[] = [
          {
            id: "workspace_may_exist",
            text: `The workspace for ${task.branch} may exist on the host; the next dispatch binds or recreates the same branch and worktree.`,
          },
        ];
        if (engine.hostHealth.launchInFlight(task.id))
          warnings.push({
            id: "effect_may_land",
            text: "This task's dispatch is still in flight; its create may still complete.",
          });
        return {
          warnings,
          apply() {
            const released = workspaceIntentReleasePatch(task);
            store.event(
              task.id,
              WORKSPACE_INTENT_RELEASED,
              JSON.stringify({ automatic: false, branch: task.branch }),
            );
            return {
              before: { workspaceIntent: true, stop },
              patch: {
                ...released,
                phase: "queued",
                reason: "Workspace intent released; requeued for dispatch",
                resolution: stop ? { ...r, stop: null, attention: false } : r,
              },
            };
          },
        };
      }
      break;
  }
  return missing(kind, id);
}

function clearEffect(
  engine: Engine,
  task: Task,
  id: string,
  reason: string,
): Plan {
  const store = engine.store;
  const warning: Warning = {
    id: "effect_may_land",
    text: "The original effect may still complete or repeat.",
  };
  const effect = splitOwnerEffectKey(id);
  const key = effect?.identity ?? id;
  const kind = effect?.kind;
  if (kind === "hook" || kind === "merged_task_retention") {
    const hook = store
      .hookEvents(task.id)
      .find((item) => item.id === key || item.eventId === key);
    if (hook && !["result", "published", "superseded"].includes(hook.state))
      return {
        warnings: [warning],
        apply() {
          store.putHookEvent({
            ...hook,
            state: "superseded",
            updatedAt: now(),
          });
          return { before: hook };
        },
      };
  }
  const operation =
    !kind || kind === "operation" || kind === "task_control_operation"
      ? store.operation(key)
      : null;
  if (operation?.taskId === task.id && unfinished(operation)) {
    return {
      warnings: [warning],
      apply() {
        settleOperation(store, operation, reason);
        return { before: operation };
      },
    };
  }
  const notice =
    (!kind || kind === "attention-notice") &&
    store.notices(task.id).find((item) => item.id === key);
  if (notice && ["pending", "intent", "uncertain"].includes(notice.status)) {
    return {
      warnings: [warning],
      apply() {
        store.putNotice({
          ...notice,
          status: "superseded",
          error: reason,
          explicitlyClearedAt: now(),
        });
        return { before: notice };
      },
    };
  }
  if (kind === "owned_tool") {
    const held = ownerPendingEffects(collectOwnerVerbFacts(store, task)).find(
      (item) => item.effect === id,
    );
    if (held)
      return {
        warnings: [
          {
            id: "owned_tool",
            text: "The recorded tool process may still be writing.",
          },
        ],
        apply() {
          store.event(
            task.id,
            "owned_tool_settled",
            JSON.stringify({ runId: key, evidence: reason }),
          );
          return { before: held };
        },
      };
  }
  const run = !kind || kind === "run-delivery" ? store.run(key) : null;
  if (run?.taskId === task.id && ["intent", "uncertain"].includes(run.status)) {
    return {
      warnings: [warning],
      apply() {
        store.putRun({
          ...run,
          status: run.released ? "superseded" : "stopped",
        });
        return { before: run };
      },
    };
  }
  if (!kind || kind === "review-delivery") {
    for (const run of store.runs(task.id)) {
      const delivery = run.reviewDeliveries?.find(
        (item) => item.deliveryId === key,
      );
      if (
        !delivery ||
        (delivery.status !== "reserved" && delivery.status !== "uncertain")
      )
        continue;
      return {
        warnings: [warning],
        apply() {
          store.putRun({
            ...run,
            reviewDeliveries: run.reviewDeliveries?.map((item) =>
              item === delivery
                ? {
                    ...item,
                    status: "refused",
                    evidence: reason.slice(0, 2000),
                    observedAt: now(),
                  }
                : item,
            ),
          });
          return { before: delivery };
        },
      };
    }
  }
  if (kind === "review_publication" || kind === "publication") {
    const publication = store.getMeta(reviewPublicationKey(key));
    if (
      publication &&
      blockingRecoveryEffects(store, task, {
        kinds: ["publication"],
        runId: key,
      }).some((effect) => effect.identity === key)
    )
      return {
        warnings: [warning],
        apply() {
          store.deleteMeta(reviewPublicationKey(key));
          return { before: publication };
        },
      };
  }
  const r = task.resolution;
  if (
    id === "project-validation.project-validation" &&
    r.projectValidation &&
    !["passed", "superseded"].includes(r.projectValidation.state)
  )
    return {
      warnings: [warning],
      apply: () => ({
        before: r.projectValidation,
        patch: {
          resolution: {
            ...r,
            projectValidation: { ...r.projectValidation!, state: "superseded" },
          },
        },
      }),
    };
  // The merge request itself stays as durable evidence for the exact-head hard gate.
  if (
    id === "merge-response.merge-response" &&
    !r.mergedCommit &&
    (r.mergeResponseOutcome === "uncertain" ||
      r.mergeRetryOutcome === "uncertain" ||
      (r.mergeIntent && r.mergeResponseOutcome === "pending"))
  )
    return {
      warnings: [warning],
      apply: () => ({
        before: {
          intent: r.mergeIntent,
          head: r.mergeHead,
          requestedAt: r.mergeRequestedAt,
          response: r.mergeResponseOutcome,
          retry: r.mergeRetryOutcome,
        },
        patch: {
          resolution: {
            ...r,
            mergeIntent: false,
            mergeResponseOutcome: "pending",
            mergeRetryOutcome: null,
            mergeRetryAt: null,
            mergeAutoRetryExhausted: true,
          },
        },
      }),
    };
  return missing("effect", id);
}
