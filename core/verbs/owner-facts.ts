import { taskNeverDispatched, liveRun } from "../task-decision-rules";
import { boardDispatchHoldApplies, BOARD_DISPATCH_HOLD_REASON } from "../../shared/board-dispatch-hold";
import { supersededWorkerResult } from "../recovery/incident";
import { holdOwnerOf, taskOwner } from "../../shared/contracts";
import { holdsOf, incidentBindsCurrentWork, taskNextRunSchema, taskNextStopSchema, taskStopKind, taskStopClassification, taskStopRecord, currentTaskStop, taskVisibleReason, DISPATCH_WAIT_REASON, blockingHoldFence, WORKER_REPLACEMENT_CEILING, type Notice, type Profile, type Run, type Task, type TaskNext, type TaskNextStop } from "../../shared/contracts";
import { type HookRecord } from "../../shared/hooks";
import type { TaskStopReason } from "../../shared/task-stop";
import { noActionEscalationAtAcceptedHead } from "../recovery/task-reasons";
import { taskBudget } from "../../shared/task-budget";
import { type Store } from "../store/store";
import { OWNER_STOP_HOLD_PREFIX } from "../merge/merge-hold";
import { blockingRecoveryEffects, recoveryEffectsRefusal } from "../recovery/recovery-effects";
import { recoveryBoundStatus } from "../recovery/recovery-bound";
import { runFenceRefusal, runSettlementFence } from "../intake/run-settlement";
import { supersededIdleBinding } from "../recovery/fence-settlement";

/** Everything the registry reads about one task; a store read, never a remote call. */
export interface OwnerVerbFacts {
  store: Store;
  task: Task;
  runs: Run[];
  events: Array<{ id: number; kind: string; detail: string; at: string }>;
  notices: Notice[];
  /** The task's recorded hook occurrences; `retry_effect` reads them as pending effects. */
  hookRecords: HookRecord[];
  /**
   * The durable task-control operation executing this read, when there is one.
   * An applied verb is not a competing writer against itself; `next` has none.
   */
  operationId?: string | null;
  /**
   * The routing profiles the task's own host reports (`Engine.profilesFor`), so
   * `next`'s routing policy carries the host effects and the selection
   * explanation that `queue.detail` shows (nucleus#1151). Absent: no snapshot.
   */
  hostProfiles?: Profile[];
  /** The engine's authenticated reporting coordinator run, when one is applying this read. */
  reportingRunId?: string | null;
  /**
   * This read is a plan, never an applied control: the task's own live
   * coordinator episode may see the bounded recheck it is meant to deliver. It
   * grants nothing — the applying path re-derives with the authenticated
   * reporting-run binding.
   */
  planning?: boolean;
  operatorBoard?: boolean;
}

export function collectOwnerVerbFacts(store: Store, task: Task, operationId?: string | null, reportingRunId?: string | null): OwnerVerbFacts {
  return { store, task, runs: store.runs(task.id), events: store.eventsAll(task.id), notices: store.notices(task.id), hookRecords: store.hookEvents(task.id), operationId: operationId ?? null, reportingRunId: reportingRunId ?? null };
}

export const prIdentity = (task: Task): boolean =>
  Boolean(task.completion?.prNumber || task.resumePrNumber || task.prUrl || task.prHead);

/** The retained author's latest reported result, shared by stop, ladder and next. */
export const latestAuthorResult = (task: Task, runs: Run[]) =>
  runs.findLast(run => run.role === 'revision' && run.agentId === task.agentId && run.completion)?.completion ?? task.completion;

/** The PR and exact head a current authenticated ready result names, with the run and event that reported it. */
type ReadyPrEvidence = { prNumber: number; head: string; runId: string; eventId: string };

/**
 * Project-d #117 (Tom, 2026-10-23): the current applicable ready result of a
 * task with no bound PR identity (no `prUrl`, `resumePrNumber` or review-entry
 * number) and a retained worker. When the task has revision runs it is the
 * latest of them: released, run by the retained worker in the task workspace,
 * with an authenticated `ready_for_review` on that run naming a PR number and
 * an exact head. Any later revision, whatever its status, an unreleased one,
 * or one by another worker supersedes an earlier ready result, so a later
 * blocked or errored revision leaves none. With no revision run it is the
 * worker's own `ready_for_review` on its run. Store reads only: an identity
 * candidate, never review credit; `move to=review` still proves it on the forge.
 */
export function currentReadyPrEvidence(task: Task, runs: Run[]): ReadyPrEvidence | null {
  if (task.prUrl || task.resumePrNumber || task.reviewEntry?.prNumber || !task.agentId || !task.workspaceId) return null;
  const latest = runs.filter(run => run.role === "revision").at(-1);
  if (latest && (!latest.released || latest.agentId !== task.agentId || latest.workspaceId !== task.workspaceId)) return null;
  const result = latest ? latest.completion : task.completion;
  const runId = latest?.id ?? task.runId;
  if (!result || !runId || result.status !== "ready_for_review" || result.taskId !== task.id || result.runId !== runId
    || !result.prNumber || !result.head) return null;
  return { prNumber: result.prNumber, head: result.head, runId, eventId: result.eventId };
}

/**
 * The recorded fence a role's next launch would hit: a run of that role that is
 * still unreleased on the thread the launch would reuse. It names the run, the
 * rule keeping it and what releases it, so a verb that hands the task to a new
 * run records this in its reply instead of reporting plain success while
 * nothing launches. One derivation, read by the verb, by the launch itself and
 * by the facts `next` reports.
 */
export function unreleasedLaunchFence(store: Store, task: Task, role: Run["role"], agentId: string | null = task.resolution.reviewerAgentId ?? null): string | null {
  if (!agentId) return null;
  const run = store.runs(task.id).findLast(candidate => !candidate.released && candidate.role === role && candidate.agentId === agentId);
  if (!run) return null;
  const why = supersededIdleBinding(store, task.id, run).why
    || (run.completion ? "its recorded result is not yet applied" : "its thread was not observed stopped");
  return `${role} run ${run.id} (agent ${agentId}) still owns the retained ${role} thread: ${why}; observation releases it once its thread is proven archived, gone or closed, or its own settlement applies`;
}

/** The engine's `neverDispatched` projection: no workspace, agent, run or PR was ever created. */
export const neverDispatched = (facts: OwnerVerbFacts): boolean => taskNeverDispatched(facts.task, facts.runs);

export const escalatedEpisode = (task: Task, runs: Run[]): boolean =>
  task.resolution.recovery?.status === "escalated"
  || (incidentBindsCurrentWork(task, runs) && task.resolution.incident?.status === "escalated");

/** The structural form of the escalation resolver's live-work guard: an episode still backed by the task's own fault. */
export const escalationBackedByLiveWork = (task: Task, runs: Run[]): boolean => {
  if (task.resolution.recoveryActive || task.resolution.mergeIntent && !task.resolution.mergedCommit) return true;
  if (noActionEscalationAtAcceptedHead(task)) return false;
  if (["dispatching", "working", "awaiting_review", "reviewing", "changes_requested", "verifying", "merging", "syncing", "closing"].includes(task.phase)) return true;
  if (task.phase === "done" || task.phase === "cancelled") return false;
  const recovery = task.resolution.recovery;
  const currentFault = task.resolution.attention || ["blocked", "error", "needs_attention"].includes(task.phase);
  // An episode backed by an incident recorded against a released run is not
  // backed by live work: the fault it names was superseded.
  return currentFault && (!recovery?.incidentId
    || (incidentBindsCurrentWork(task, runs) && recovery.incidentId === task.resolution.incident?.id));
};

/** A blocked or errored worker report on the worker's own run (no run record exists for it). */
export const workerBlockedOnOwnRun = (task: Task, facts: OwnerVerbFacts): boolean =>
  Boolean(task.completion && ["blocked", "error"].includes(task.completion.status)
    && task.completion.runId === task.runId && !facts.runs.some(run => run.id === task.runId));

export function ownerStoppedRunIds(events: OwnerVerbFacts["events"]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    try {
      const detail = JSON.parse(event.detail) as { runIds?: unknown; runId?: unknown };
      if (event.kind === "owner_stopped" && Array.isArray(detail.runIds))
        for (const id of detail.runIds) if (typeof id === "string") ids.add(id);
      if (event.kind === "owner_restart_instruction_sent" && typeof detail.runId === "string") ids.delete(detail.runId);
    } catch { /* historical audit rows remain readable */ }
  }
  return ids;
}

/**
 * The unresolved delivery and effect fences a worker replacement owes before it
 * stops, releases or supersedes that worker's run (Spec 050). `restart role=worker
 * fresh` and `route role=worker now` read this one derivation, so the two
 * controls refuse the same uncertain occurrence instead of one of them
 * displacing work the other preserves (review 5696038429 finding 2).
 */
export function retainedWorkerDeliveryRefusal(facts: OwnerVerbFacts): string | null {
  const { task, runs, store } = facts;
  const revisions = runs.filter(run => run.role === 'revision' && !run.released);
  if (revisions.some(run => run.agentId !== task.agentId || run.workspaceId !== task.workspaceId) || revisions.length > 1)
    return "Another revision still owns this task; resolve the retained thread or delivery before replacing the worker";
  const revision = revisions[0];
  if (revision?.completion)
    return "The revision result is awaiting reconciliation; wait for it to settle before replacing the worker";
  const effects = blockingRecoveryEffects(store, task).filter(item => item.runId !== null
    && (item.runId === revision?.id || item.runId === task.runId));
  return recoveryEffectsRefusal(effects);
}

/**
 * The budget figure `next` reads (nucleus#1187): the same call the dispatch gates
 * and the views make, from the task row, its runs and its events.
 */
export const ownerTaskBudget = (facts: OwnerVerbFacts) => taskBudget(facts.task, facts.runs, Date.now(), facts.events);

/**
 * The one honest sentence `next` carries once a task has retired enough workers
 * that the worker replacement ceiling applies (Spec 050). It reports the real
 * count and the operator-relayed restart that can pass it; it grants nothing.
 */
export function replacementAllowanceNote(task: Task): string | null {
  const retirements = task.retiredWorkers.length;
  if (retirements < WORKER_REPLACEMENT_CEILING) return null;
  return `Nucleus has retired ${retirements} workers (the replacement ceiling is ${WORKER_REPLACEMENT_CEILING}). A further replacement needs an operator-relayed restart role=worker fresh.`;
}

/**
 * Round 4: the durable side effect, if any, that an owner verb will not act
 * over blindly when it displaces the task's runs — unknown delivery, a pending
 * authenticated delivery or a blocking recovery effect — with what clears it.
 * The handlers' displace mode refuses on exactly these.
 */
export function durableRunFence(facts: OwnerVerbFacts): string | null {
  const refusals = facts.runs.filter(run => !run.released)
    .map(run => {
      const why = runSettlementFence(facts, run);
      return why ? runFenceRefusal(run, why) : null;
    }).filter((refusal): refusal is string => refusal !== null);
  return refusals.length ? refusals.join('; ') : null;
}

/**
 * The task's initial worker binding while it is a live participant: the initial
 * worker is stored on the task row (runId, agentId), never as a Run, so a
 * stored run list holds only later or older resolution runs. A stopped or
 * completed binding is history named by the stop, never an active participant.
 * Read-only: nothing is inserted or inferred beyond the row.
 */
function initialWorkerBinding(facts: OwnerVerbFacts): TaskNext["activeRun"] {
  const { task, runs } = facts;
  if (!task.runId || !task.agentId || task.resolution.currentRunId || runs.some(run => run.id === task.runId)) return null;
  // A later revision of the same worker delivered a result, so the initial run
  // is finished history whatever still carries its ID.
  if (supersededWorkerResult(task, runs)) return null;
  // Only a live fact names the binding: a stall record not yet completed, an
  // unresolved worker incident, the current run_stalled stop, or a live worker
  // phase. A resolved incident or completed stall that still carries the old
  // run ID is history and never outranks a later run, and an incident of
  // another role inherits the task's run ID without naming the worker live
  // (#381: an open coordinator incident showed the initial worker running).
  const stall = task.resolution.stalledTurnStop?.runId === task.runId && task.resolution.stalledTurnStop.status !== "completed"
    ? task.resolution.stalledTurnStop : null;
  const ownerStoppedIdle = ownerStoppedRunIds(facts.events).has(task.runId)
    && holdsOf(task).dispatch?.reason.startsWith(OWNER_STOP_HOLD_PREFIX)
    && task.lastAgentStatus === "idle" && task.agentActive === false;
  const incident = task.resolution.incident;
  const openIncident = incident && incident.status !== "resolved" && incident.role === "worker" && incident.runId === task.runId;
  if (!["dispatching", "working"].includes(task.phase) && !ownerStoppedIdle && !stall && !openIncident && task.resolution.stop?.reason !== "run_stalled") return null;
  // A stall Queue observed stopped has released the worker's lease, and a
  // recorded initial completion is a finished result: both are history named by
  // the stop, so no live binding remains (Queue #477 review 5675271170).
  const stopped = stall?.status === "stopped";
  const completion = task.completion?.runId === task.runId ? task.completion : null;
  if (stopped || completion) return null;
  const ownerStopped = ownerStoppedRunIds(facts.events).has(task.runId);
  const observedStopped = ownerStopped && task.lastAgentStatus === "idle" && task.agentActive === false;
  return taskNextRunSchema.parse({
    runId: task.runId, role: "worker", agentId: task.agentId,
    profileId: task.profile?.id ?? null, profileName: task.profile?.name ?? null,
    status: observedStopped ? "stopped" : "running", released: false, lastActivity: task.lastObservedAt ?? null, summary: null,
  });
}

export function ownerActiveRun(facts: OwnerVerbFacts): TaskNext["activeRun"] {
  const { task, runs } = facts;
  const current = task.resolution.currentRunId ? facts.store.run(task.resolution.currentRunId) : null;
  // A result is recorded before publication and application clear the current
  // binding, so the recorded current run is live only while it has neither
  // reported nor been released. That completed run's evidence stays readable
  // through the outcome and the stop, never as the active participant.
  const live = liveRun(current) ? current : null;
  if (!live) { const initial = initialWorkerBinding(facts); if (initial) return initial; }
  // A released or finished run is history: the stop, the outcome and the run
  // list still name it, but it is never the participant holding the task. Only
  // a run that has neither reported nor been released is live (Queue #477: a
  // released recovery run read as the active reader while a finished reviewer
  // read as live).
  const run = live ?? runs.findLast(liveRun) ?? null;
  if (!run) return null;
  const observedStopped = ownerStoppedRunIds(facts.events).has(run.id)
    && run.agentId === task.agentId
    && task.lastAgentStatus === "idle" && task.agentActive === false;
  return taskNextRunSchema.parse({
    runId: run.id, role: run.role, agentId: run.agentId,
    profileId: run.profile?.id ?? null, profileName: run.profile?.name ?? null,
    status: observedStopped ? "stopped" : run.status, released: run.released, lastActivity: run.lastObservedAt,
    summary: run.completion?.summary ?? null,
  });
}

/**
 * Compose a stop detail so the recovery note survives: the original reason is
 * bounded to leave room for the note, so a maximal accepted reason (a hold's or
 * a task control's, up to 4,000 characters) can never truncate the charged count
 * and work basis away (review 5673077554).
 */
function withRecoveryNote(text: string, note: string, limit = 2000): string {
  if (!note) return text.slice(0, limit);
  const room = Math.max(0, limit - note.length - 2);
  const head = text.length > room ? `${text.slice(0, Math.max(0, room - 1)).trimEnd()}…` : text;
  return `${head} ${note}`.slice(0, limit);
}

/**
 * The current stop or wait with its reason, owner and evidence: the hold fence,
 * else the open incident, else the owning recovery episode, else the attention
 * park, else a recorded wait. A progressing task has no stop. The category and
 * its precedence are `taskStopKind` in the shared contracts, so the board badge
 * and this read never drift apart; this adds the reason, owner and evidence.
 */
export function ownerTaskStop(facts: OwnerVerbFacts): TaskNextStop | null {
  const { task, runs } = facts;
  // One measurement (nucleus#1187): the stop this reads is the one the same
  // budget figure supports, so a pause the gates no longer see is not a stop here.
  const budget = ownerTaskBudget(facts);
  if (!facts.store.getMeta("paused") && facts.store.getMeta("dispatchHeld") === true && boardDispatchHoldApplies(task) && !holdsOf(task).dispatch)
    return { kind: "wait", reason: "held", suggestedVerbs: [], detail: BOARD_DISPATCH_HOLD_REASON, owner: "operator", evidence: "Board dispatch hold", since: task.updatedAt };
  const kind = taskStopKind(task, runs, budget);
  if (!kind) return null;
  const stored = currentTaskStop(task, budget);
  // No recorded stop: type it from the stop kind. Only a queued task's reason is
  // Queue's own dispatch text to classify; any other reason may be an agent's report.
  // A row released before its release reset the hold text still says "Dispatch
  // held"; with no fence left it waits for dispatch like any queued task.
  const reasonText = kind === "wait" && taskStopClassification(task.reason).reason === "held" ? DISPATCH_WAIT_REASON : task.reason;
  const fallback: TaskStopReason = kind === "hold" ? "held"
    : kind === "wait" ? (task.prerequisiteWait && !task.prerequisiteWait.releasedAt ? "prerequisite" : taskStopClassification(reasonText).reason)
      : "operator_needed";
  const classified = stored ?? taskStopRecord(fallback, reasonText || "Waiting to dispatch", null, task.createdAt);
  // Tom, 2026-10-27: the bounded recovery loop is the owner's to read, not only
  // to hit. The charged launch count and the work basis it is charged to are
  // stated in the existing stop detail once any coordinator run is counted, so
  // an owner sees what an ordinary restart or route preserves and why the
  // breaker is (or stays) exhausted. Derived read only: no new field or record.
  const bound = runs.some(run => run.role === 'recovery') || task.resolution.recovery
    ? recoveryBoundStatus(facts.store, task)
    : { charged: 0, limit: 0, basis: '' };
  const boundNote = bound.charged > 0
    ? `Coordinator recovery: ${bound.charged} of ${bound.limit} launches are charged to the current work (${bound.basis}); a routine restart or route at unchanged work does not reset that count, and one explicit restart role=coordinator re-arms it.`
    : '';
  const latestAuthorReport = latestAuthorResult(task, runs);
  // Preserve independent stop reasons, but replace a detail copied from the
  // initial author result when a later revision has reported.
  const earlierAuthorIncident = task.resolution.incident?.role === 'worker'
    && task.resolution.incident.runId === task.completion?.runId && latestAuthorReport?.runId !== task.completion?.runId;
  const stopDetail = task.completion && latestAuthorReport && (classified.detail === task.completion.summary || earlierAuthorIncident)
    ? latestAuthorReport.summary : classified.detail;
  const stopFields = {
    reason: classified.reason, since: classified.since,
    detail: withRecoveryNote(stopDetail, boundNote),
    suggestedVerbs: classified.suggestedVerbs,
  };
  const fences = holdsOf(task);
  if (kind === "hold") {
    // A hold stop is its owner's gate whatever wait the task last recorded: a
    // held submission still carries its creation-time "Waiting for dispatch".
    // `taskStopKind` names a hold only while a fence exists. The fence named is the
    // one that blocks now (the board card shows the same one), else merge first.
    const named = blockingHoldFence(task) ?? (fences.merge
      ? { kind: "merge" as const, fence: fences.merge }
      : { kind: "dispatch" as const, fence: fences.dispatch! });
    const { fence } = named;
    return taskNextStopSchema.parse({
      kind, ...stopFields, reason: "held", suggestedVerbs: [], since: fence.at,
      // The hold stays truthful about its own reason and owner, and the charged
      // recovery count and work basis stay readable beside it (review
      // 5672912042): the owner must see what an ordinary restart preserves even
      // while a hold is the visible wait.
      detail: withRecoveryNote(fence.reason, boundNote), owner: holdOwnerOf(task, fence.owner),
      evidence: `${named.kind} hold generation ${fence.generation}${fence.until ? ` until ${fence.until}` : ""}`,
    });
  }
  if (kind === "incident") {
    const incident = task.resolution.incident!;
    return taskNextStopSchema.parse({
      kind, ...stopFields,
      owner: taskOwner(task) || null,
      evidence: `incident ${incident.id} (${incident.cause}, ${incident.status}) on ${incident.runId ?? "no run"}: ${incident.detail}`,
    });
  }
  if (kind === "recovery") {
    const recovery = task.resolution.recovery!;
    return taskNextStopSchema.parse({
      kind, ...stopFields, owner: "coordinator",
      evidence: `recovery ${recovery.id} (${recovery.status}, generation ${recovery.generation}) on ${recovery.runId ?? "no run"}`,
    });
  }
  if (kind === "attention") return taskNextStopSchema.parse({
    kind, ...stopFields, owner: taskOwner(task) || null,
    evidence: facts.notices.find(notice => notice.kind === "attention" && notice.status === "pending")?.text ?? null,
  });
  if (kind === "run") {
    const checkpointed = retainedCheckpointRun(runs);
    if (checkpointed) {
      const ordinal = checkpointed.reviewCheckpoints!.at(-1)!.ordinal;
      return taskNextStopSchema.parse({
        kind, ...stopFields, owner: taskOwner(task) || null,
        evidence: checkpointed.retainedAgentClosedAt
          ? `reviewer run ${checkpointed.id} (agent ${checkpointed.agentId}) holds checkpoint ${ordinal} at ${checkpointed.head}; its agent was observed closed in ${checkpointed.workspaceId} at ${checkpointed.retainedAgentClosedAt}, so the same-agent continuation is impossible`
          : `reviewer run ${checkpointed.id} holds checkpoint ${ordinal} at ${checkpointed.head}; continuation needs explicit authorization`,
      });
    }
    const author = latestAuthorReport;
    if (author) return taskNextStopSchema.parse({
      kind, ...stopFields, detail: author.summary || classified.detail, owner: taskOwner(task) || null,
      evidence: `worker run ${author.runId} reported ${author.status} (${author.eventId})`,
    });
    // No result recorded (a stalled initial worker or resolution run): name the
    // run the stop is about from stored bindings only.
    const openIncidentRun = incidentBindsCurrentWork(task, runs) ? task.resolution.incident!.runId : null;
    const runId = task.resolution.stalledTurnStop?.runId ?? openIncidentRun ?? task.resolution.currentRunId ?? task.runId;
    const stored = runId ? runs.find(run => run.id === runId) : undefined;
    const role = stored?.role ?? (runId && runId === task.runId ? "worker" : "run");
    const agentId = stored?.agentId ?? (runId === task.runId ? task.agentId : null);
    return taskNextStopSchema.parse({
      kind, ...stopFields, owner: taskOwner(task) || null,
      evidence: runId ? `${role} run ${runId}${agentId ? ` (agent ${agentId})` : ""} has no recorded result: ${classified.detail}` : classified.detail,
    });
  }
  if (task.prerequisiteWait && !task.prerequisiteWait.releasedAt) return taskNextStopSchema.parse({
    kind, ...stopFields, detail: task.prerequisiteWait.reason, owner: "queue",
    evidence: `waiting for ${task.prerequisiteWait.waitsFor.join(", ")}`,
  });
  return taskNextStopSchema.parse({
    kind, ...stopFields, owner: "queue", evidence: null,
  });
}

/**
 * The unreleased, unreported reviewer that holds a saved checkpoint: the retained
 * participant a continuation keeps. `next`'s stop and the recovery launch snapshot
 * both name it through this one finder.
 */
export const retainedCheckpointRun = (runs: Run[]): Run | undefined => runs.find(run => run.role === "reviewer" && !run.released
  && !run.completion && (run.reviewCheckpoints?.length ?? 0) > 0);

