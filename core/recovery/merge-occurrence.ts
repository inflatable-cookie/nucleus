import type { Task } from "../../shared/contracts";
import { digest, type Store } from "../store/store";
import { plannerEscalations } from "../questions/ladder/records";
import { escalationWaitDetail } from "../questions/ladder/waits";

type OccurrenceStore = Pick<Store, "eventsAll" | "run" | "runs">;

/** The stop is the planner, unknown-delivery or attached wait of this escalation. */
function stopNamesEscalation(task: Task, id: string): boolean {
  const stop = task.resolution.stop;
  return Boolean(
    stop &&
      stop.reason === "escalated" &&
      stop.fact?.code === "escalation" && stop.fact.subject === id,
  );
}

/** The PR is the one the episode and the verified merge name, and it is still at the merged head. */
function prNamesMerge(task: Task, number: number): boolean {
  try {
    const path = new URL(task.prUrl ?? "").pathname;
    return (
      new RegExp(`^/[^/]+/[^/]+/pull/${number}/?$`).test(path) &&
      task.prHead === task.resolution.mergeHead
    );
  } catch {
    return false;
  }
}

type IncidentRecord = { id: string; status: string };

/** The incident an `incident` journal record names, or null when it is unreadable. */
function incidentRecord(detail: string): IncidentRecord | null {
  try {
    const value = JSON.parse(detail) as { id?: unknown; status?: unknown };
    if (typeof value.id !== "string" || typeof value.status !== "string")
      return null;
    return { id: value.id, status: value.status };
  } catch {
    return null;
  }
}

/**
 * True when the journal proves this no-run episode's own escalation derived
 * `incidentId`. The escalation writer attaches an incident and then opens the
 * episode's recovery-pending question in one synchronous step (see
 * `coordinator-pass`). So the proof needs that incident's creation record to be
 * the last incident record before the question, a fresh reconciling record, the
 * episode's opening to precede it, and no earlier record of the same
 * incident. A question another cause opened, or an incident recorded before the
 * opening, proves nothing; its incident keeps its own exit.
 */
function escalationDerivedIncident(
  store: OccurrenceStore,
  task: Task,
  episodeId: string,
  incidentId: string,
): boolean {
  const events = store.eventsAll(task.id);
  const cause = digest(`recovery-pending:${task.id}:${episodeId}`);
  const questions = plannerEscalations(events).filter(
    (item) => item.cause === cause && item.runId === null,
  );
  if (questions.length !== 1) return false;
  const question = events.find(
    (event) =>
      event.kind === "planner_escalation" &&
      event.detail.startsWith(`${questions[0]!.id}:`),
  );
  if (!question) return false;
  const created = events
    .filter((event) => event.kind === "incident" && event.id < question.id)
    .at(-1);
  const record = created ? incidentRecord(created.detail) : null;
  if (
    !created ||
    !record ||
    record.id !== incidentId ||
    record.status !== "reconciling"
  )
    return false;
  const opening = events.findLast(
    (event) => event.kind === "recovery_pending" && event.id < created.id,
  );
  if (!opening) return false;
  return !events.some(
    (event) =>
      event.kind === "incident" &&
      event.id < opening.id &&
      incidentRecord(event.detail)?.id === incidentId,
  );
}

/**
 * The incident a no-run episode holds. Its opening witness is the immutable
 * authority for the incident it began with. The episode's attachment can differ
 * from that only after its own escalation attached a derived incident, which
 * counts only when the journal proves the derivation.
 */
function openingIncidentHolds(
  store: OccurrenceStore,
  task: Task,
  recovery: NonNullable<Task["resolution"]["recovery"]>,
  openedWith: string | null,
): boolean {
  if (openedWith === recovery.incidentId) return true;
  return (
    recovery.incidentId !== null &&
    escalationDerivedIncident(store, task, recovery.id, recovery.incidentId)
  );
}

/**
 * An episode that never launched a run. Its unbound pre-merge witness must name
 * this exact episode, key, generation, PR and head, and no recovery run of its
 * generation may exist. A witness bound to a run would instead need that run.
 */
function noRunEpisodeOvertaken(
  store: OccurrenceStore,
  task: Task,
  number: number,
): boolean {
  const recovery = task.resolution.recovery;
  const witness = recovery?.mergeWitness;
  if (
    !recovery ||
    recovery.status === "resolved" ||
    recovery.agentId ||
    recovery.action ||
    !witness
  )
    return false;
  if (
    witness.episodeId !== recovery.id ||
    !openingIncidentHolds(store, task, recovery, witness.incidentId) ||
    witness.stopKey !== recovery.key ||
    witness.runId !== null ||
    witness.generation !== recovery.generation ||
    witness.prNumber !== number ||
    witness.head !== task.resolution.mergeHead ||
    witness.mergedCommit !== null
  )
    return false;
  return !store
    .runs(task.id)
    .some(
      (run) =>
        run.role === "recovery" && run.generation === recovery.generation,
    );
}

/** Identify an overtaken run. Clearing a stop needs its own occurrence proof. */
export function recoveryOvertakenByMerge(
  store: OccurrenceStore,
  task: Task,
): boolean {
  const { recovery, mergeHead, mergedCommit } = task.resolution;
  const number =
    task.reviewEntry?.prNumber ??
    task.resumePrNumber ??
    task.completion?.prNumber;
  if (!recovery || !number || !mergeHead || !mergedCommit) return false;
  if (!prNamesMerge(task, number)) return false;
  if (!recovery.runId) return noRunEpisodeOvertaken(store, task, number);
  const run = store.run(recovery.runId);
  if (
    !run ||
    run.taskId !== task.id ||
    run.role !== "recovery" ||
    run.head !== mergeHead ||
    run.generation !== recovery.generation
  )
    return false;
  const witness = recovery.mergeWitness;
  if (witness)
    return (
      witness.episodeId === recovery.id &&
      witness.incidentId === recovery.incidentId &&
      witness.stopKey === recovery.key &&
      witness.runId === run.id &&
      witness.generation === run.generation &&
      witness.prNumber === number &&
      witness.head === mergeHead &&
      witness.mergedCommit === null
    );

  // Legacy records carry only a digest. The ordered journal must identify this
  // very run before the one recorded verification; a timestamp or digest alone
  // cannot establish what the coordinator was asked to recover.
  const events = store.eventsAll(task.id);
  const merges = events.filter((event) => event.kind === "merge_verified");
  if (
    merges.length !== 1 ||
    !task.resolution.mergeIntent ||
    task.resolution.externalMerge ||
    task.prHead !== mergeHead
  )
    return false;
  const launches = events.filter((event) => {
    if (event.kind !== "telemetry_recovery") return false;
    try {
      return (JSON.parse(event.detail) as { runId?: unknown }).runId === run.id;
    } catch {
      return false;
    }
  });
  const action = recovery.action;
  const accepted = events.find(
    (event) =>
      event.kind === "merge_response_accepted" &&
      event.detail === `GitHub accepted the guarded merge for ${mergeHead}`,
  );
  const binding =
    action &&
    events.find(
      (event) =>
        event.kind === "recovery_action_bound" &&
        event.detail === action.eventId,
    );
  const applied = events.find(
    (event) => event.kind === "run_result_applied" && event.detail === run.id,
  );
  const released = events.find(
    (event) =>
      event.kind === "run_released_from_recorded_completion" &&
      event.detail === `recovery ${run.id}`,
  );
  if (
    !accepted ||
    !action ||
    action.runId !== run.id ||
    action.eventId !== run.completion?.eventId ||
    action.reportStatus !== run.completion?.status ||
    !binding ||
    launches.length !== 1 ||
    !(
      accepted.id < launches[0]!.id &&
      launches[0]!.id < binding.id &&
      binding.id < merges[0]!.id
    )
  )
    return false;
  const originalStop =
    !task.resolution.stop ||
    digest(
      `stop:${task.resolution.stop.reason}:${task.resolution.stop.since}`,
    ) === recovery.key;
  // The bound report predates verification even if the current stop was later
  // replaced. The caller may retire this run, but clears only a proved stop.
  if (action.status === "pending") return true;
  if (
    action.status !== "applied" ||
    !run.released ||
    !released ||
    !applied ||
    !(merges[0]!.id < released.id && released.id < applied.id)
  )
    return false;
  if (originalStop) return true;
  return (
    legacyRecoveryEscalation(store, task, applied.id) !== null &&
    legacyRecoveryOwnsStop(store, task)
  );
}

/**
 * The recovery-pending escalation a no-run episode opened, when the task's exact
 * stop still names it. It is still open, or the verified merge outlived it (its
 * routing answered it by ordinary progress and the stop remained). Its cause is
 * digested from this episode's own id, so no other episode can claim it.
 */
export function noRunEscalationOwnsStop(
  store: Pick<Store, "eventsAll">,
  task: Task,
): string | null {
  const recovery = task.resolution.recovery;
  if (!recovery || recovery.runId) return null;
  const events = store.eventsAll(task.id);
  const cause = digest(`recovery-pending:${task.id}:${recovery.id}`);
  const match = plannerEscalations(events).find(
    (item) =>
      item.cause === cause &&
      item.runId === null &&
      (!item.answered ||
        events.some(
          (event) =>
            event.kind === "planner_escalation_answered" &&
            event.detail ===
              `${item.id}: answered by ordinary progress: the task merged or ended first`,
        )) &&
      stopNamesEscalation(task, item.id),
  );
  return match?.id ?? null;
}

/** The one typed escalation this legacy recovery report opened, if its chain is complete. */
export function legacyRecoveryEscalation(
  store: Pick<Store, "eventsAll">,
  task: Task,
  after = 0,
): string | null {
  const events = store.eventsAll(task.id);
  const runId = task.resolution.recovery?.runId;
  if (!runId) return null;
  const matches = plannerEscalations(events)
    .filter((item) => item.runId === runId)
    .filter((item) =>
      events.some((event) => {
        if (
          event.kind !== "planner_escalation_payload" ||
          event.id <= after ||
          !event.detail.startsWith(`${item.id}:`)
        )
          return false;
        try {
          const payload = JSON.parse(
            event.detail.slice(event.detail.indexOf(":") + 1),
          ) as { id?: unknown; runId?: unknown; source?: unknown };
          return (
            payload.id === item.id &&
            payload.runId === runId &&
            payload.source === "recovery"
          );
        } catch {
          return false;
        }
      }),
    );
  return matches.length === 1 ? matches[0]!.id : null;
}

/** A ladder wait is this occurrence only when its exact stored stop names its escalation. */
export function legacyRecoveryOwnsStop(
  store: Pick<Store, "eventsAll">,
  task: Task,
): boolean {
  const stop = task.resolution.stop;
  const id = legacyRecoveryEscalation(store, task);
  if (!stop || stop.reason !== "escalated" || !id) return false;
  if (!stopNamesEscalation(task, id)) return false;
  const events = store.eventsAll(task.id);
  const payload = events.find(
    (event) =>
      event.kind === "planner_escalation_payload" &&
      event.detail.startsWith(`${id}:`),
  );
  const wait = events.findLast(
    (event) => event.kind === "task_waiting" || event.kind === "task_stopped",
  );
  if (
    !payload ||
    !wait ||
    wait.id <= payload.id ||
    wait.kind !== "task_waiting"
  )
    return false;
  try {
    return JSON.stringify(JSON.parse(wait.detail)) === JSON.stringify(stop);
  } catch {
    return false;
  }
}
