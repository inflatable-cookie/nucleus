import type { Run, Task } from "./contracts";
import type {
  ParticipantActivity,
  ParticipantProcess,
  TaskActivity,
} from "./schema/task-activity";
import {
  automaticBudgetExtensionDue,
  budgetGatesPhase,
  type BudgetEvent,
  type TaskBudgetView,
} from "./task-budget";
import { DEFAULT_STALL_THRESHOLD_MINUTES } from "./schema/settings/capacity";
import { REVISION_BUDGET } from "./incident";
import { holdsOf, isOperatorOwner } from "./holds";
import { isDispositionActive } from "./disposition";
import { blockingHold, isTerminalPhase, taskStateLabel } from "./task-state";
import {
  isUncertainCreationStop,
  type TaskStopReason,
  type TaskStopRecord,
} from "./task-stop";
import { waitStateLabels, type WaitStateView } from "./wait-state";

export type ProcessLiveness = "alive" | "gone" | "unknown";

export interface ActivityReadContext {
  paused?: boolean;
  dispatchHeld?: boolean;
  quietMs?: number;
  processLiveness?: (
    process: ParticipantProcess | null,
    now: number,
    binding: { taskId: string; runId: string },
  ) => ProcessLiveness;
}

interface TaskActivityFacts {
  task: Task;
  runs: readonly Run[];
  events: readonly BudgetEvent[];
  stop: TaskStopRecord | null;
  wait?: WaitStateView | null;
  budget?: TaskBudgetView | null;
  read?: ActivityReadContext;
  now: number;
}

const runRoles: Record<Run["role"], NonNullable<TaskActivity["role"]>> = {
  revision: "worker",
  reviewer: "reviewer",
  recovery: "coordinator",
  verification: "coordinator",
  closeout: "closeout",
  executor: "executor",
};

const stopWords: Record<TaskStopReason, string> = {
  awaiting_proof: "Waiting for proof",
  operator_needed: "Needs an owner decision",
  run_stalled: "Participant turn stalled",
  origin_busy: "Waiting for the source thread",
  capacity: "Waiting for capacity",
  provider_unavailable: "Waiting for a provider",
  route_unavailable: "Waiting for an eligible route",
  pr_head_lag: "Waiting for the published head",
  prerequisite: "Waiting for prerequisites",
  workspace_unavailable: "Waiting for the workspace",
  validation: "Waiting for validation",
  held: "Held",
  lifecycle: "Waiting for Nucleus",
  external_unavailable: "Waiting for an external service",
  host_unavailable: "Waiting on the host",
  interactive: "Waiting for a reply",
  responsible_question: "Waiting for an answer",
  escalated: "Waiting for a planner decision",
  budget: "Task budget reached",
  paused_stop: "Waiting for the queue to resume",
};

const personStops = new Set<TaskStopReason>([
  "operator_needed",
  "interactive",
  "responsible_question",
  "escalated",
  "budget",
]);

/**
 * The event a planner's, the operator's or a delegated answer's author-round
 * control records when it starts one more round past the revision cap. It ends
 * the exhausted allowance as an author round would, so the launch gate lets that
 * round's revision launch.
 */
export const REVISION_CAP_ACCEPTED_EVENT = "revision_cap_accepted";

/**
 * The author revision allowance is spent: the cap park stopped the task (a new
 * changes_required review at `REVISION_BUDGET` rounds) and since then no author
 * round has started and no planner or operator has accepted one. This is the
 * scheduler's own condition, the one the revision launch gate, the cap park and
 * the author-round rule read; six rounds alone, or rounds inside a round an owner
 * approved after the park, are not the cap (papercut 677c378d).
 */
export function revisionAllowanceExhausted(
  task: Pick<Task, "resolution">,
  runs: readonly Run[],
  events: readonly BudgetEvent[],
): boolean {
  if (task.resolution.revisionRuns < REVISION_BUDGET) return false;
  const capAt = events.findLast(
    (event) => event.kind === "revision_budget_exhausted",
  )?.at;
  return (
    Boolean(capAt) &&
    !runs.some((run) => run.role === "revision" && run.createdAt >= capAt!) &&
    !events.some(
      (event) =>
        event.kind === REVISION_CAP_ACCEPTED_EVENT && event.at >= capAt!,
    )
  );
}

/** The stop a revision launch held at the cap records. */
export function revisionCapHoldDetail(task: Pick<Task, "resolution">): string {
  return (
    `Revision cap reached: ${task.resolution.revisionRuns} of ${REVISION_BUDGET} review rounds, and no author round has started since the cap stopped the task. ` +
    'The revision launch holds until the planner decides: the explicit run.start for the worker with accept ["budget"] starts one more round (planner or operator board), as does the ladder\'s answer to the cap escalation.'
  );
}

/**
 * Spec 068 §3: the event a coordinator pass records when its coordinator's host
 * read failed on a host fault or transport failure and the observation waits
 * for the next pass, inside a bound, instead of escalating.
 */
export const COORDINATOR_OBSERVATION_DEFERRED_EVENT =
  "coordinator_observation_deferred";

export type CoordinatorObservationDeferral = {
  runId: string;
  since: string;
  until: string;
  cause: string;
};

/**
 * The deferral still in force for this coordinator run: one recorded since the
 * run's last good observation. A later observation moves `lastObservedAt`, so an
 * older deferral no longer reads as current.
 */
export function coordinatorObservationDeferral(
  events: readonly BudgetEvent[],
  run: Pick<Run, "id" | "lastObservedAt" | "createdAt">,
): CoordinatorObservationDeferral | null {
  const since = run.lastObservedAt ?? run.createdAt;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.kind !== COORDINATOR_OBSERVATION_DEFERRED_EVENT) continue;
    try {
      const detail = JSON.parse(
        event.detail,
      ) as Partial<CoordinatorObservationDeferral>;
      if (detail.runId !== run.id) continue;
      return detail.since === since &&
        detail.until &&
        detail.cause !== undefined
        ? (detail as CoordinatorObservationDeferral)
        : null;
    } catch {
      continue;
    }
  }
  return null;
}

function boundActivity(
  runId: string | null,
  agentId: string | null,
  observation?: ParticipantActivity | null,
) {
  return observation?.runId === runId && observation.agentId === agentId
    ? observation
    : null;
}

function fresh(
  at: string | null | undefined,
  now: number,
  limit: number,
): at is string {
  if (!at) return false;
  const age = now - Date.parse(at);
  return age >= 0 && age < limit;
}

function latest(...times: Array<string | null | undefined>): string | null {
  return times.reduce<string | null>(
    (newest, time) =>
      time &&
      Number.isFinite(Date.parse(time)) &&
      (!newest || Date.parse(time) > Date.parse(newest))
        ? time
        : newest,
    null,
  );
}

function slotDetail(task: Task, stop: TaskStopRecord | null): string {
  const text = stop?.detail ?? task.reason;
  const ahead = /waiting behind (\d+) in-flight/.exec(text)?.[1];
  const position = /^Waiting for QA capacity \(position (\d+)\)/.exec(
    text,
  )?.[1];
  if (position) return `Waiting for QA capacity · position ${position}`;
  const slot =
    task.phase === "awaiting_review" ||
    task.phase === "reviewing" ||
    task.entrypoint === "review"
      ? "review"
      : task.phase === "changes_requested"
        ? "revision"
        : "project";
  if (slot === "project" && !ahead) return waitStateLabels.waiting_capacity;
  return `Waiting for a ${slot} slot${ahead ? ` · ${ahead} ahead` : ""}`;
}

function toolName(name: string): string {
  // A command can contain arbitrary arguments. Keep its short name and omit raw
  // identifiers and paths from the human-facing status.
  return (
    name
      .replace(/[\u0000-\u001f\u007f`]/g, " ")
      .replace(
        /\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b|\b[\da-f]{12,}\b/gi,
        "…",
      )
      .replace(/(?:^|\s)(?:\/|~\/|\.{1,2}\/)[^\s]+/g, " …")
      .replace(/\b(?:[\w.-]+#\d+|(?:thread|agent|run):[\w.:-]+)\b/g, "…")
      .trim() || "tool"
  );
}

/** One read of the current activity. It never decides or applies an action. */
export function taskActivity({
  task,
  runs,
  events,
  stop,
  wait,
  budget,
  read,
  now,
}: TaskActivityFacts): TaskActivity {
  const { resolution } = task;
  const current = runs.find(
    (run) => run.id === resolution.currentRunId && !run.released,
  );
  const live =
    current && !current.completion
      ? current
      : runs.findLast((run) => !run.released && !run.completion);
  const workerBound = Boolean(
    task.runId &&
      task.agentId &&
      !task.completion &&
      !runs.some(
        (run) => run.role === "revision" && run.agentId === task.agentId,
      ) &&
      ["dispatching", "working"].includes(task.phase),
  );
  const observation = live
    ? boundActivity(live.id, live.agentId, live.participantActivity)
    : workerBound
      ? boundActivity(task.runId, task.agentId, task.participantActivity)
      : null;
  const recordedRunning = live ? live.status === "running" : workerBound;
  const active =
    recordedRunning &&
    (observation
      ? Boolean(observation.turnStartedAt)
      : (live ? live.active : task.agentActive) === true);
  const activityAt = live
    ? live.lastActivityAt
    : workerBound
      ? task.lastActivityAt
      : null;
  const lastActivityAt = latest(
    task.lastActivityAt,
    ...runs.map((run) => run.lastActivityAt),
    observation?.tool?.lastOutputAt,
  );
  const role = live ? runRoles[live.role] : workerBound ? "worker" : null;
  const label = taskStateLabel({ ...task, waitState: wait ?? undefined });
  const answer = (
    state: TaskActivity["state"],
    detail: string,
    since = task.updatedAt,
    extra: Partial<TaskActivity> = {},
  ): TaskActivity => ({ state, role, since, detail, lastActivityAt, ...extra });

  if (isTerminalPhase(task.phase))
    return answer("finished", label, task.finishedAt ?? task.updatedAt, {
      role: null,
      occurrence: "finished",
    });

  const hold = blockingHold(task);
  if (hold) {
    const fences = holdsOf(task);
    const fence = hold === "merge" ? fences.merge : fences.dispatch;
    const waitsForRelease =
      fence?.until && (hold !== "both" || fences.merge?.until);
    return answer(
      waitsForRelease ? "nucleus" : "needs_person",
      label,
      fence?.at ?? task.holdAt ?? task.updatedAt,
      { occurrence: `hold:${hold}:${fence?.at ?? task.holdAt ?? ""}` },
    );
  }
  if (
    wait?.state === "needs_operator_input" ||
    wait?.state === "needs_source_rights" ||
    (wait?.state === "waiting_prerequisite" && isOperatorOwner(wait.owner))
  )
    return answer("needs_person", waitStateLabels[wait.state], stop?.since, {
      occurrence: `wait:${wait.state}:${wait.decisionId ?? ""}`,
    });
  if (stop && personStops.has(stop.reason))
    return answer("needs_person", stopWords[stop.reason], stop.since, {
      occurrence: `stop:${stop.reason}:${stop.since}`,
    });
  const recovery = resolution.recovery;
  const incident = resolution.incident;
  if (recovery?.status === "escalated" || incident?.status === "escalated")
    return answer(
      "needs_person",
      "Waiting for a planner decision",
      incident?.updatedAt ?? stop?.since,
      {
        occurrence: `escalated:${incident?.id ?? ""}:${incident?.updatedAt ?? ""}`,
      },
    );
  if (observation?.permission) {
    const permission = observation.permission;
    return answer(
      "needs_person",
      permission.kind === "question"
        ? "Waiting for an answer"
        : "Waiting for permission",
      permission.since,
      { permission, occurrence: `permission:${permission.since}` },
    );
  }
  // Nucleus waits, inside a bound, for the coordinator's host to answer a read. The
  // deferral's own start (the run's last good observation) owns the reading, so a
  // later deferral after a good observation is a new occurrence.
  const coordinatorRun =
    recovery?.runId && ["running", "nudged"].includes(recovery.status)
      ? runs.find((run) => run.id === recovery.runId && !run.released)
      : undefined;
  const deferral = coordinatorRun
    ? coordinatorObservationDeferral(events, coordinatorRun)
    : null;
  if (deferral)
    return answer(
      "nucleus",
      "Waiting for the coordinator's host to answer",
      deferral.since,
      {
        role: "coordinator",
        occurrence: `coordinator-host:${deferral.runId}:${deferral.since}`,
      },
    );
  if (
    recovery &&
    ["pending", "running", "nudged", "uncertain"].includes(recovery.status)
  )
    return answer(
      "recovering",
      recovery.status === "uncertain"
        ? "Checking uncertain coordinator creation"
        : "Recovering the task",
      incident?.createdAt ?? stop?.since,
      {
        role: "coordinator",
        attempt: resolution.recoveryAttempts,
        occurrence: `recovery:${recovery.id}`,
      },
    );
  // Spec 068 §3: the host may still answer a launch's create command. That is
  // Nucleus waiting on a named fact, not a repair: no thread may be started for
  // the run until the answer lands or its bound passes. The initial worker has no
  // run row, so its subject is the task's own run id.
  if (stop?.fact?.code === "creation_in_flight") {
    const subject = runs.find((run) => run.id === stop.fact?.subject);
    return answer(
      "nucleus",
      "Waiting for the host to answer a launch",
      stop.since,
      {
        role: subject
          ? runRoles[subject.role]
          : stop.fact.subject === task.runId
            ? "worker"
            : role,
        occurrence: `launch:${stop.fact.subject ?? ""}:${stop.since}`,
      },
    );
  }
  if (live?.status === "uncertain" || isUncertainCreationStop(stop))
    return answer(
      "recovering",
      `Checking uncertain ${role ?? (stop?.fact?.code === "worker_lookup" ? "worker" : "participant")} creation`,
      stop?.since ?? live?.createdAt,
      {
        attempt: incident?.attempt ?? 1,
        occurrence: `uncertain:${live?.id ?? stop?.fact?.code ?? ""}:${stop?.since ?? live?.createdAt ?? ""}`,
      },
    );

  const readProcess = (runId: string, observed: ParticipantActivity | null) =>
    read?.processLiveness?.(observed?.process ?? null, now, {
      taskId: task.id,
      runId,
    }) ?? "unknown";
  const runId = live?.id ?? (workerBound ? task.runId : null);
  const process = runId ? readProcess(runId, observation) : "unknown";
  if (process === "gone" && (workerBound || live?.status === "running"))
    return answer(
      "unclassified",
      `${role === "worker" ? "Worker" : role === "reviewer" ? "Reviewer" : "Participant"} process is gone`,
      activityAt ?? live?.createdAt ?? task.updatedAt,
      { occurrence: `gone:${runId ?? ""}` },
    );
  const reported =
    current?.role === "reviewer" || !live
      ? runs.findLast(
          (run) =>
            run.role === "reviewer" &&
            !run.released &&
            run.head === task.prHead &&
            (run.completion?.status === "ready_to_merge" ||
              run.completion?.status === "changes_required") &&
            !events.some(
              (event) =>
                (event.kind === "review_result_applied" ||
                  event.kind === "review_reapplied") &&
                event.detail === run.id,
            ),
        )
      : undefined;
  if (reported) {
    const observed = boundActivity(
      reported.id,
      reported.agentId,
      reported.participantActivity,
    );
    if (observed?.threadGone || readProcess(reported.id, observed) === "gone")
      return answer(
        "unclassified",
        "Review verdict is waiting on a gone thread",
        reported.lastObservedAt ?? reported.createdAt,
        { role: "reviewer", occurrence: `reported-gone:${reported.id}` },
      );
  }

  // Spec 068 §5: a spent budget or revision cap is the owner's, never "progressing".
  // The sweep records the budget stop; until it has, the reading says what it is.
  // A first spend is not one: the sweep extends it once on its own (Decision 1).
  if (
    budget?.exhausted &&
    budgetGatesPhase(task.phase) &&
    !automaticBudgetExtensionDue(task) &&
    !stop &&
    !wait &&
    !resolution.hostWait &&
    !live
  )
    return answer("needs_person", stopWords.budget, undefined, {
      occurrence: `budget:${task.phase}`,
    });
  if (
    ["changes_requested", "needs_attention"].includes(task.phase) &&
    revisionAllowanceExhausted(task, runs, events) &&
    !live &&
    !stop
  )
    return answer("needs_person", "Revision cap reached", undefined, {
      occurrence: `revision-cap:${task.phase}:${task.resolution.revisionRuns}`,
    });

  const quietMs = read?.quietMs ?? DEFAULT_STALL_THRESHOLD_MINUTES * 60_000;
  const runningTool = observation?.tool;
  if (
    runningTool &&
    process !== "gone" &&
    fresh(latest(runningTool.lastOutputAt, runningTool.startedAt), now, quietMs)
  ) {
    const minutes = Math.max(
      0,
      Math.floor((now - Date.parse(runningTool.startedAt)) / 60_000),
    );
    const tool = {
      name: toolName(runningTool.name),
      startedAt: runningTool.startedAt,
      lastOutputAt: runningTool.lastOutputAt,
    };
    return answer(
      "active",
      `Running \`${tool.name}\` · ${minutes} min`,
      tool.startedAt,
      {
        tool,
        occurrence: `tool:${observation?.runId ?? ""}:${runningTool.startedAt}`,
      },
    );
  }
  if (active && fresh(activityAt, now, quietMs))
    return answer(
      "active",
      role === "reviewer" ? "Reviewer is working" : label,
      observation?.turnStartedAt ?? live?.createdAt ?? activityAt,
      { occurrence: `turn:${observation?.turnStartedAt ?? live?.id ?? ""}` },
    );
  if (read?.dispatchHeld && task.phase === "queued")
    return answer("needs_person", "Dispatch held by the operator", undefined, {
      occurrence: `dispatch-hold:${task.holdAt ?? ""}`,
    });
  if (resolution.hostWait)
    return answer(
      "nucleus",
      stopWords.host_unavailable,
      resolution.hostWait.since,
      {
        occurrence: `host-wait:${resolution.hostWait.hostId}:${resolution.hostWait.since}`,
      },
    );
  if (wait?.state === "waiting_capacity" || stop?.reason === "capacity")
    return answer("nucleus", slotDetail(task, stop), stop?.since, {
      role:
        role ??
        (task.phase === "awaiting_review" || task.entrypoint === "review"
          ? "reviewer"
          : "worker"),
      occurrence: `capacity:${stop?.since ?? ""}`,
    });
  if (wait?.state === "waiting_prerequisite" || wait?.state === "merge_hold")
    return answer("nucleus", waitStateLabels[wait.state], stop?.since, {
      occurrence: `wait:${wait.state}:${stop?.since ?? ""}`,
    });
  if (stop) {
    const fact = stop.fact?.code ?? task.reasonFact?.code;
    const occurrence = `stop:${stop.reason}:${stop.since}`;
    if (fact === "integration_turn")
      return answer(
        "nucleus",
        "Waiting for the repository integration turn",
        stop.since,
        { occurrence },
      );
    if (fact === "check_deadline" || stop.detail === "PR checks are pending")
      return answer("nucleus", "Waiting for required checks", stop.since, {
        occurrence,
      });
    if (stop.reason === "run_stalled")
      return answer("unclassified", stopWords.run_stalled, stop.since, {
        occurrence,
      });
    return answer("nucleus", stopWords[stop.reason], stop.since, {
      occurrence,
    });
  }
  if (reported)
    return answer(
      "nucleus",
      "Applying the review verdict",
      reported.createdAt,
      { role: "reviewer", occurrence: `applying:${reported.id}` },
    );
  if (isDispositionActive(task))
    return answer("nucleus", label, undefined, {
      occurrence: "disposition",
    });
  if (
    live?.status === "intent" ||
    (task.phase === "dispatching" && (task.agentIntent || task.workspaceIntent))
  )
    return answer(
      "nucleus",
      "Starting a participant",
      live?.createdAt ?? task.updatedAt,
      { occurrence: `starting:${live?.id ?? ""}:${live?.createdAt ?? ""}` },
    );
  if (task.phase === "queued")
    return answer(
      "nucleus",
      read?.paused ? stopWords.paused_stop : "Waiting for dispatch",
      task.createdAt,
      { occurrence: `queued:${task.createdAt}` },
    );
  // A reading with no live run or wait is owned by the last participant that concluded:
  // a fresh gap after another run is a new occurrence, and a poll of the same gap is not.
  return answer(
    "unclassified",
    `${label} · ${role ? "no recent activity" : "no live run or wait"}`,
    activityAt ?? task.updatedAt,
    {
      occurrence: `reading:${task.phase}:${runs.findLast((run) => run.released || run.completion)?.id ?? ""}`,
    },
  );
}
