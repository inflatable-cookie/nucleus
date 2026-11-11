/**
 * Spec 050 fence settlement and finished-run release: the helpers owner verbs
 * use to retire the records and leases they make obsolete. Lives in its own
 * module so the resolution paths that settle inside an existing transaction
 * can import them without a cycle through the verb registry.
 */
import { settlementHeld, startsNoRuns } from "../closeout/queue-drain";
import { now, type Store } from "../store/store";
import type { Run, Task } from "../../shared/contracts";
import { holdsOf, isDispositionActive } from "../../shared/contracts";
import type { Engine } from "../engine";
import type { Adapter } from "../host/adapter";
import { recordProofExecution, timelineSelectorEvidence } from "../qa/proof-execution";
import { blockingRecoveryEffectsRefusal } from "./recovery-effects";
import { reviewContinuationWait, reviewInProgress } from "../review/review-continuation";
import { readToolTimeline } from "./stall";
import { participantToolRunIds } from "./task-reasons";

/** What one fence settlement changed, for its audit event. */
export interface SettledFences {
  incident: boolean;
  recovery: boolean;
  attentionNotices: number;
  checkpointIntent: boolean;
  externalMergePreAttention: boolean;
}

/**
 * Mark every fence an owner control makes obsolete as superseded: the open
 * incident, the owning recovery episode and its pending accepted action. A
 * matching coordinator owner verb is recorded as applied atomically; every
 * other pending report is refused, never retried. Settle pending attention notices (including
 * callback reminders), the
 * pending checkpoint continuation intent and a stale external-merge pre-attention
 * record. The historical events and records are retained; only their live fence
 * state closes. Later verbs call this so no stale record blocks the next verb.
 *
 * Runs in the caller's transaction when one is open, so a verb can settle the
 * fences atomically with the action it applies; a refusal inside that
 * transaction rolls the settlement back.
 */
export function settleSupersededFences(store: Store, taskId: string, detail: string, at = now(), appliedRecoveryRunId?: string): SettledFences {
  if (store.db.isTransaction) return settleSupersededFencesInTx(store, taskId, detail, at, appliedRecoveryRunId);
  return store.transaction(() => settleSupersededFencesInTx(store, taskId, detail, at, appliedRecoveryRunId));
}

/** The settlement body; caller owns the transaction. */
export function settleSupersededFencesInTx(store: Store, taskId: string, detail: string, at = now(), appliedRecoveryRunId?: string): SettledFences {
  const note = `Superseded by an owner control: ${detail}`.slice(0, 2000);
  const task = store.task(taskId);
  const resolution = task.resolution;
  const priorRecovery = resolution.recovery;
  const incident = resolution.incident && resolution.incident.status !== "resolved"
    ? { ...resolution.incident, status: "resolved" as const, detail: `${note}; original: ${resolution.incident.detail}`, updatedAt: at }
    : null;
  // An episode's pending accepted action is stale the moment the verb
  // supersedes the episode unless this is the coordinator verb bound to the
  // same run. Preserve that applied outcome atomically; every other pending
  // action is refused so no retry handler can execute it later.
  const pendingRecoveryAction = priorRecovery?.action?.status === "pending" ? priorRecovery.action : null;
  const coordinatorActionApplied = Boolean(pendingRecoveryAction?.coordinatorAction && pendingRecoveryAction.runId === appliedRecoveryRunId);
  const recovery = priorRecovery && priorRecovery.status !== "resolved"
    ? { ...priorRecovery, status: "resolved" as const, summary: `${note}; original: ${priorRecovery.summary}`,
        ...(pendingRecoveryAction ? { action: coordinatorActionApplied
          ? { ...pendingRecoveryAction, status: "applied" as const }
          : { ...pendingRecoveryAction, status: "refused" as const, reason: `Not applied; ${note}`.slice(0, 4000) } } : {}) }
    : null;
  const checkpointIntent = task.checkpoints.intent?.status === "pending";
  const externalMergePreAttention = Boolean(resolution.externalMergePreAttention);
  // The aggregate attention flag is only a fence for the open incident,
  // recovery, reminder or external-merge check that raised it. Settling those
  // settles the flag too, so the control that supersedes them is never refused
  // by the stale flag.
  const pendingAttention = store.notices(task.id).some(notice => notice.kind === "attention" && notice.status === "pending");
  const clearAttention = resolution.attention
    && Boolean(incident || recovery || checkpointIntent || externalMergePreAttention || pendingAttention);
  const resolutionPatch = incident || recovery || externalMergePreAttention || clearAttention || coordinatorActionApplied;
  if (resolutionPatch || checkpointIntent) {
    store.update(task.id, {
      ...(resolutionPatch ? {
        resolution: {
          ...resolution,
          ...(incident ? { incident } : {}),
          ...(recovery ? { recovery, recoveryActive: false } : {}),
          ...(externalMergePreAttention ? { externalMergePreAttention: null } : {}),
          ...(clearAttention ? { attention: false } : {}),
          ...(coordinatorActionApplied ? { stop: null } : {}),
        },
      } : {}),
      ...(checkpointIntent ? { checkpoints: { ...task.checkpoints, intent: null } } : {}),
    }, "owner_fence_settled", note);
  }
  if (incident) {
    // The incident record event, so the resolved state lands in the same
    // event vocabulary the recovery path already reads.
    store.event(task.id, "incident", JSON.stringify({
      id: incident.id, role: incident.role, runId: incident.runId, attempt: incident.attempt,
      cause: incident.cause, action: incident.action, status: incident.status,
    }));
  }
  // A later owner control explicitly replaces an uncertain task-control
  // attempt. Retain its diagnostic and record why it no longer owns the task.
  for (const operation of store.operations({ taskId, states: ["needs_attention"], limit: 1000 })) {
    if (operation.kind !== "task_control") continue;
    const payload = store.operationPayload(operation.id) as { control?: { action?: string } } | null;
    if (payload?.control?.action !== "retry_effect") continue;
    store.putOperation({ ...operation, state: "succeeded", settledAt: at, diagnostic: "",
      result: { taskId, taskVersion: store.task(taskId).version, phase: store.task(taskId).phase,
        number: store.task(taskId).number ?? null, reference: store.task(taskId).reference ?? null },
      effect: operation.effect ? { ...operation.effect, status: "reconciled", result: note, resultAt: at } : null });
  }
  let attentionNotices = 0;
  for (const notice of store.notices(task.id)) {
    if (notice.kind === "attention" && notice.status === "pending") {
      store.putNotice({ ...notice, status: "superseded", error: note });
      attentionNotices++;
    }
  }
  return {
    incident: incident !== null,
    recovery: recovery !== null,
    attentionNotices,
    checkpointIntent,
    externalMergePreAttention,
  };
}

/**
 * Whether one unreleased run is superseded by the canonical callback binding:
 * the same task, episode and generation checks the authenticated callback
 * path uses, so a run this names can no longer have a report accepted. A run
 * is superseded only when it is claimed by none of them: not the task's
 * current run, not the legacy task/worker run, not the current recovery
 * episode's run, and carrying no reservation or creation intent and no pending
 * authenticated delivery. A coordinative run of an old generation is
 * superseded even where the episode still names it, because the generation
 * check alone refuses its report; a current-generation run the episode no
 * longer names is superseded too, because the episode binding refuses it.
 * Runs with a recorded completion are never superseded here: the finished-run
 * release path owns them, so a current result-pending run — including a
 * reader with an unaccepted or just-accepted report — always stays held.
 * `settledClaim` says the replaced claim is already settled by a proven-ended
 * thread; it relaxes only that one rule, so every delivery, intent, stop,
 * effect and identity check still holds.
 * No writes happen here.
 */
export function supersededIdleBinding(store: Store, taskId: string, run: Run, options: { settledClaim?: boolean } = {}): { superseded: boolean; why: string } {
  const task: Task = store.task(taskId);
  if (!run || run.taskId !== taskId || run.released) return { superseded: false, why: "already released" };
  if (run.completion) return { superseded: false, why: "recorded completion" };
  if (run.id === task.resolution.currentRunId) return { superseded: false, why: "task current run" };
  if (run.id === task.runId) return { superseded: false, why: "task worker run" };
  if (run.id === task.resolution.recovery?.runId) return { superseded: false, why: "current recovery episode run" };
  if (run.status === "intent") return { superseded: false, why: "creation intent" };
  if (run.status === "uncertain") return { superseded: false, why: "uncertain delivery" };
  // Replaced is not released (planner ruling, 2026-11-09): a replaced reviewer
  // holds its claim — its exact-head verdict still authenticates — until the
  // review settles and its own settlement path releases it.
  if (run.replacedAt && !run.completion && !options.settledClaim) return { superseded: false, why: "replaced reviewer claim" };
  if (!run.agentId) return { superseded: false, why: "no bound agent" };
  if ((run.reviewDeliveries ?? []).some(delivery => delivery.status === "reserved" || delivery.status === "uncertain"))
    return { superseded: false, why: "pending authenticated delivery" };
  const stop = task.resolution.stalledTurnStop;
  if (stop && stop.runId === run.id && stop.status !== "completed")
    return { superseded: false, why: "stalled-turn stop intent" };
  const intent = task.checkpoints.intent;
  if (intent && intent.status === "pending" && intent.runId === run.id)
    return { superseded: false, why: "checkpoint continuation intent" };
  return { superseded: true, why: "" };
}

/**
 * Release one binding-superseded never-reporting run: the lease releases once
 * with all history kept — the run is marked superseded, one event names the
 * run and the rule, and no completion is invented. When the run still owns
 * the recovery episode, the episode closes with it (a pending accepted action
 * for that run is recorded as not applied, never retried); an episode that
 * already moved on is left alone. Returns false when the binding moved under
 * the caller. Caller owns the transaction.
 */
export function supersedeIdleRunInTx(store: Store, taskId: string, run: Run, detail: string): boolean {
  const latest = store.run(run.id);
  if (!latest || latest.released || latest.completion) return false;
  if (!supersededIdleBinding(store, taskId, latest).superseded) return false;
  store.putRun({ ...latest, status: "superseded", released: true, active: false });
  store.event(taskId, "run_released_from_observed_liveness", `${latest.role} ${latest.id}: ${detail}`.slice(0, 2000));
  const current = store.task(taskId);
  const recovery = current.resolution.recovery;
  if (latest.role !== "recovery") return true;
  if (!current.resolution.recoveryActive && !(recovery?.runId === latest.id && recovery.status !== "resolved")) return true;
  const pending = recovery?.runId === latest.id && recovery.action?.status === "pending" ? recovery.action : null;
  store.update(taskId, {
    resolution: { ...current.resolution, recoveryActive: false,
      ...(recovery && recovery.status !== "resolved"
        ? { recovery: { ...recovery, status: "resolved" as const, summary: `${detail}; the run reported no result`.slice(0, 4000),
            ...(pending ? { action: { ...pending, status: "refused" as const, reason: `Not applied; ${detail}`.slice(0, 4000) } } : {}) } }
        : {}) },
  }, "recovery_episode_observably_idle", latest.id);
  return true;
}

/**
 * Round 4 (Tom, 2026-10-19): release one run an owner verb displaced, whatever
 * its callback binding said. The verb has already confirmed the agent idle or
 * cancelled its turn; only unknown delivery and pending durable effects fence,
 * and the caller checked those. A recorded completion is kept as history and
 * released as finished; a never-reporting run is superseded. The task's
 * pointers to the run are cleared, and a recovery episode it owned closes with
 * any pending accepted action recorded as not applied. A late callback from the
 * run is stale. Caller owns the transaction.
 */
export function supersedeDisplacedRunInTx(store: Store, taskId: string, runId: string, detail: string): boolean {
  const latest = store.run(runId);
  if (!latest || latest.released || latest.taskId !== taskId || ["intent", "uncertain"].includes(latest.status)) return false;
  store.putRun({ ...latest, status: latest.completion ? "finished" : "superseded", released: true, active: false });
  store.event(taskId, "run_displaced_by_owner_verb", `${latest.role} ${latest.id}: ${detail}`.slice(0, 2000));
  const current = store.task(taskId);
  const recovery = current.resolution.recovery;
  const ownsEpisode = recovery?.runId === latest.id && recovery.status !== "resolved";
  const pending = ownsEpisode && recovery?.action?.status === "pending" ? recovery.action : null;
  const isCurrent = current.resolution.currentRunId === latest.id;
  if (!isCurrent && !ownsEpisode && !(latest.role === "recovery" && current.resolution.recoveryActive)) return true;
  store.update(taskId, {
    resolution: {
      ...current.resolution,
      ...(isCurrent ? { currentRunId: null } : {}),
      ...(isCurrent && latest.role === "reviewer" ? { reviewerAgentId: null, reviewerProfile: null } : {}),
      ...(latest.role === "recovery" ? { recoveryActive: false } : {}),
      ...(ownsEpisode && recovery
        ? { recovery: { ...recovery, status: "resolved" as const, summary: `${detail}; the run was displaced by an owner verb`.slice(0, 4000),
            ...(pending ? { action: { ...pending, status: "refused" as const, reason: `Not applied; ${detail}`.slice(0, 4000) } } : {}) } }
        : {}),
    },
  }, "run_displaced_by_owner_verb", latest.id);
  return true;
}

/**
 * Release one finished run from its recorded completion — the same release
 * write the reconciliation quantum (`Engine.settleFinishedRuns`) uses. Recovery
 * runs go through `Recovery.settleFinishedRun` instead, which carries the
 * episode bookkeeping. Caller owns the transaction; one event names the run,
 * and the normal thread-archive path picks the released binding up.
 */
export function releaseRunFromRecordedCompletion(store: Store, taskId: string, run: Run): void {
  const latest = store.run(run.id);
  if (!latest || latest.released || !latest.completion) return;
  store.putRun({ ...latest, status: "finished", released: true });
  store.event(taskId, "run_released_from_recorded_completion", `${latest.role} ${latest.id}`);
}

/**
 * Release the runs no report will settle: finished, observably idle, superseded
 * or never launched. Same-name `Engine` methods delegate here. Calls between
 * these methods go back through the engine so tests that replace them on the
 * instance still see them.
 */
export class RunRelease {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get resolution() { return this.engine.resolution; }
  get stopped() { return this.engine.stopped; }

  /**
   * Release a run whose completion is durably recorded but unreleased.
   *
   * A transport outage can interrupt the release step after a completion has been recorded:
   * the run then reads running, active and unreleased while its agent has long since closed,
   * and every operator route that requires all runs released refuses - revise and a parked
   * restart both do. The completion is the evidence that the run finished, so
   * settling it is bookkeeping rather than a blind retry, and it has to happen in
   * reconciliation or the next outage leaves the same finished work unable to move.
   */
  settleFinishedRuns(task: Task) {
    // Pause stores a recovery escalate and defers its origin message until unpause.
    // Dispatch hold still settles this path; stop does not.
    if (startsNoRuns(this.store, this.stopped)) return;
    // Narrow on purpose. A completion that carries a decision - recovered, ready_for_review,
    // verified - must be acted on by the ordinary path under whatever lease the task holds,
    // and releasing its run here would bypass that. The case this exists for is a run that
    // concluded with nothing left to do and whose release step was lost: a coordinator that
    // escalated. Observed live as a recovery run reading running/active/unreleased hours
    // after its agent closed, holding every operator route hostage.
    const runs = this.store.runs(task.id).filter(run => !run.released && run.completion &&
      run.role === "recovery" && run.completion.status === "escalate");
    if (!runs.length) return;
    this.store.transaction(() => {
      for (const run of runs) {
        this.store.putRun({ ...run, status: 'finished', released: true });
        this.store.event(task.id, 'run_released_from_recorded_completion', `${run.role} ${run.id}`);
      }
      let latest = this.store.task(task.id);
      if (latest.resolution.recoveryActive) {
        latest = this.resolution.update(latest, { recoveryActive: false });
      }
      // Releasing the current recovery run without recording its escalation left the
      // recovery reading "running" with budget left, so the next pass launched another
      // coordinator for the same issue (observed live, 2026-09-27: three coordinators
      // each escalating one planning decision). Escalation is idempotent.
      const current = runs.find(run => run.id === latest.resolution.recovery?.runId);
      if (current && latest.resolution.recovery?.status !== 'escalated') {
        this.resolution.recovery.escalate(latest, current.completion!.summary);
      }
    });
  }

  /**
   * Spec 050 reconciliation (papercut-promoted 2026-10-23): a checkpointed
   * reviewer whose own agent is positively observed closed in its workspace,
   * with no active turn and no pending permission, can never receive the
   * retained-agent continuation. Record that terminal observation on the run
   * and the honest owner stop so `next` stops advertising the impossible
   * continuation and offers the existing fresh-review recovery instead.
   *
   * Nothing else moves: the lease stays unreleased (so no verdict is lost and no
   * replacement is launched), the checkpoints, receipt, credential, head, PR and
   * workspace identity are untouched, and only the owner's own verb settles the
   * run. An exhausted checkpoint budget and a hold each keep their own stop: the
   * owner already has a supported path recorded. Any read that fails, is
   * ambiguous, or shows a live, permission-pending, idle, errored or relocated
   * agent leaves the fence exactly as it was.
   */
  async reconcileClosedRetainedReviewer(taskId: string): Promise<void> {
    if (settlementHeld(this.store, this.stopped)) return;
    const task = this.store.task(taskId);
    if (task.removedAt || ["done", "cancelled"].includes(task.phase) || isDispositionActive(task)) return;
    const fences = holdsOf(task);
    if (fences.dispatch || fences.merge) return;
    const run = task.resolution.currentRunId ? this.store.run(task.resolution.currentRunId) : null;
    if (!run || run.role !== "reviewer" || run.released || run.completion || !run.agentId) return;
    // A paused-stop marker owns the thread until its unpause resume settles; a
    // closed observation during that window is the resumable-session case, not a
    // reviewer that left (Queue #650).
    if (run.pausedStop) return;
    if (!reviewInProgress(run) || run.reviewBudgetExhaustedAt || run.retainedAgentClosedAt) return;
    if ((run.reviewDeliveries ?? []).some(delivery => delivery.status === "reserved" || delivery.status === "uncertain")) return;
    const stall = task.resolution.stalledTurnStop;
    if (stall && stall.runId === run.id && stall.status !== "completed") return;
    if (task.checkpoints.intent && task.checkpoints.intent.status === "pending" && task.checkpoints.intent.runId === run.id) return;
    const version = task.version, runIdentity = JSON.stringify(this.store.runs(taskId));
    let observed: Awaited<ReturnType<Adapter["observe"]>>;
    try { observed = await this.engine.host.observe(run.agentId); } catch { return; }
    if (settlementHeld(this.store, this.stopped)) return;
    if (!observed || observed.id !== run.agentId || observed.workspaceId !== run.workspaceId) return;
    if (observed.active || observed.activeTurnId || observed.permissions) return;
    if (observed.status !== "closed") return;
    let recorded = false;
    this.store.transaction(() => {
      const current = this.store.task(taskId);
      const latest = this.store.run(run.id);
      // The observation belongs to this exact run and task state: a callback, a
      // checkpoint, a delivery, a control or a run change during the await wins.
      if (current.version !== version || JSON.stringify(this.store.runs(taskId)) !== runIdentity) return;
      if (!latest || latest.released || latest.completion || latest.agentId !== run.agentId || latest.workspaceId !== run.workspaceId) return;
      if (latest.head !== run.head || current.resolution.currentRunId !== latest.id) return;
      if (!reviewInProgress(latest) || latest.reviewBudgetExhaustedAt || latest.retainedAgentClosedAt) return;
      const at = now();
      this.store.putRun({ ...latest, retainedAgentClosedAt: at, active: false, lastObservedAt: at, idleSince: latest.idleSince ?? at });
      this.store.event(taskId, "reviewer_agent_closed", JSON.stringify({ runId: latest.id, agentId: latest.agentId,
        workspaceId: latest.workspaceId, head: latest.head, checkpointOrdinal: latest.reviewCheckpoints?.at(-1)?.ordinal ?? null, observedAt: at }));
      recorded = true;
    });
    // The stop is recorded through the ordinary wait writer once the flag is
    // durable, so `next` and the board read the same typed record as every other
    // checkpoint stop, naming the exact run, agent, checkpoint and head. A held
    // task kept its own stop above.
    if (recorded) {
      const current = this.store.task(taskId);
      this.resolution.waiting(current, reviewContinuationWait(current, this.store).reason, "operator_needed");
    }
  }

  /**
   * Spec 050 terminal-cleanup observed-liveness settlement (papercut
   * b87375b0). End-of-task cleanup and `retry_effect` on a finished task run
   * this before they act: a run whose agent is positively observed idle, with
   * no active turn and no pending permission, is released with its history
   * kept, so a never-reporting run cannot hold a finished task's workspace
   * archive or block a retried side effect. Ruled by observation, never by
   * phase: an unobservable agent, a run with no bound agent, or an agent in
   * another workspace is never settled here, and a live agent always fences.
   * A recorded completion keeps the reconciliation release path; a
   * never-reporting run is superseded in place and, when it owned the recovery
   * episode, that episode closes so `recoveryActive` clears. A terminal task
   * whose recovery episode is still active closes it once no recovery run is
   * unreleased, even when that run was released long ago (Queue #680). Returns
   * how many runs released.
   */
  async settleObservedIdleRuns(taskId: string, detail: string): Promise<number> {
    let settled = 0;
    // Recovery runs this pass releases. Each release may clear `recoveryActive` before the
    // terminal settlement runs, so the settlement needs these ids to find the episode they owned.
    const releasedRecoveryRuns: string[] = [];
    for (const run of this.store.runs(taskId).filter(candidate => !candidate.released)) {
      if (settlementHeld(this.store, this.stopped)) return settled;
      if (await this.engine.observedRunLiveness(run) !== false) continue;
      if (settlementHeld(this.store, this.stopped)) return settled;
      this.store.transaction(() => {
        const latest = this.store.run(run.id);
        if (!latest || latest.released) return;
        if (latest.role === "recovery") releasedRecoveryRuns.push(latest.id);
        if (latest.completion) {
          if (latest.role === "recovery") this.resolution.recovery.settleFinishedRun(this.store.task(taskId), latest, detail);
          else releaseRunFromRecordedCompletion(this.store, taskId, latest);
          settled++;
          return;
        }
        // A never-reporting run: release the lease with all history kept.
        this.store.putRun({ ...latest, status: "superseded", released: true, active: false });
        this.store.event(taskId, "run_released_from_observed_liveness", `${latest.role} ${latest.id}: ${detail}`);
        const current = this.store.task(taskId);
        const recovery = current.resolution.recovery;
        if (latest.role === "recovery" && (current.resolution.recoveryActive || recovery?.runId === latest.id)) {
          this.resolution.update(current, {
            recoveryActive: false,
            ...(recovery && recovery.status !== "resolved"
              ? { recovery: { ...recovery, status: "resolved" as const, summary: `${detail}; the run reported no result` } } : {}),
          }, {}, "recovery_episode_observably_idle", latest.id);
        }
        settled++;
      });
    }
    // A released or superseded recovery run cannot hold the episode open, and the
    // loop above never reads it again.
    this.engine.settleTerminalRecoveryEpisode(taskId, detail, releasedRecoveryRuns);
    return settled;
  }

  /**
   * Spec 050 terminal recovery settlement (Queue #680). Once no recovery run of a
   * done or cancelled task is unreleased, its episode closes with a recorded event
   * and the incident it owns settles with it. The episode is active, or a recovery
   * run released in this pass owned it (`releasedRunIds`); a release may already
   * have cleared `recoveryActive`. A live or unobservable unreleased recovery run
   * still fences. Store-only: no adapter read, so it is safe on any pass. Returns
   * whether an episode closed.
   */
  settleTerminalRecoveryEpisode(taskId: string, cause: string, releasedRunIds: readonly string[] = []): boolean {
    if (settlementHeld(this.store, this.stopped)) return false;
    let closed = false;
    this.store.transaction(() => {
      const current = this.store.task(taskId);
      if (!['done', 'cancelled'].includes(current.phase)) return;
      const episodeOwned = releasedRunIds.some(id => id === current.resolution.recovery?.runId || id === current.resolution.incident?.runId);
      if (!current.resolution.recoveryActive && !episodeOwned) return;
      if (this.store.runs(taskId).some(run => run.role === "recovery" && !run.released)) return;
      const detail = `Task is ${current.phase} and no recovery run is unreleased; the active recovery episode closed (${cause})`;
      const changes = this.resolution.recovery.settledEpisodeChanges(current, detail, episodeOwned);
      if (!changes) return;
      this.resolution.update(current, changes, {}, "recovery_episode_settled", detail);
      closed = true;
    });
    return closed;
  }

  /** A terminal task cannot launch a reserved run: settle its agentless creation intent on sweep. */
  settleTerminalIntentRuns(taskId: string): number {
    let settled = 0;
    this.store.transaction(() => {
      let task = this.store.task(taskId);
      if (!['done', 'cancelled'].includes(task.phase)) return;
      for (const candidate of this.store.runs(taskId)) {
        if (candidate.released || candidate.status !== 'intent' || candidate.agentId != null) continue;
        const run = this.store.run(candidate.id);
        if (!run || run.released || run.status !== 'intent' || run.agentId != null) continue;
        const reason = `Abandoned because task is ${task.phase}; run never launched (intent has no agent)`;
        this.store.putRun({ ...run, status: 'superseded', released: true, active: false });
        this.store.event(taskId, 'run_intent_abandoned', `${run.role} ${run.id}: ${reason}`);
        task = this.store.task(taskId);
        const recovery = task.resolution.recovery;
        const ownsRecovery = recovery?.runId === run.id && recovery.status !== 'resolved';
        if (task.resolution.currentRunId === run.id || ownsRecovery || (run.role === 'recovery' && task.resolution.recoveryActive)) {
          this.store.update(taskId, { resolution: {
            ...task.resolution,
            ...(task.resolution.currentRunId === run.id ? { currentRunId: null } : {}),
            ...(run.role === 'recovery' ? { recoveryActive: false } : {}),
            ...(ownsRecovery && recovery ? { recovery: { ...recovery, status: 'resolved', summary: reason } } : {}),
          } }, 'terminal_run_intent_abandoned', run.id);
          task = this.store.task(taskId);
        }
        settled++;
      }
    });
    return settled;
  }

  /**
   * Spec 050 superseded-idle settlement (Queue #339). The one general rule for
   * a never-reporting run, on finished and unfinished tasks: a stored run the
   * canonical callback binding proves superseded — claimed by neither the
   * task's current run, the task/worker run, the current recovery episode nor
   * a reservation, creation intent or pending authenticated delivery — whose
   * agent is freshly observed idle in the run's workspace with no active turn
   * and no pending permission, and whose owned-tool and effect safeguards
   * pass, releases once with its history kept. A run that is agentless,
   * unreadable, of unknown or active state, permission-blocked, or carrying
   * an ambiguous or uncertain effect stays held, and a run with a recorded
   * completion always stays held here: the finished-run release path owns it.
   * Holds write nothing, so a pass with nothing settleable leaves the task
   * untouched. Returns how many runs released.
   */
  async settleSupersededIdleRuns(taskId: string, detail: string): Promise<number> {
    let settled = 0;
    if (this.store.task(taskId).removedAt) return settled;
    for (const run of this.store.runs(taskId).filter(candidate => !candidate.released)) {
      if (settlementHeld(this.store, this.stopped)) return settled;
      if (!supersededIdleBinding(this.store, taskId, run).superseded) continue;
      if (await this.engine.supersededIdleFence(run) !== null) continue;
      if (settlementHeld(this.store, this.stopped)) return settled;
      let done = false;
      this.store.transaction(() => { done = supersedeIdleRunInTx(this.store, taskId, run, detail); });
      if (done) settled++;
    }
    return settled;
  }

  /**
   * Task 560: settle one superseded proof executor's still-running execution
   * record from timeline-only evidence. A released or binding-superseded run
   * can no longer hold the task, but its record must not read `running`
   * forever when no report ever comes: when its agent's own timeline positively
   * proves the declared selector ran (a terminal shell tool call whose command
   * invokes the selector — the launched command itself, never a textual
   * mention — read with complete coverage), the record settles as
   * historical evidence with status `unknown` — it ran, and no result was ever
   * reported. It spends no allowance, is never a pass, and can never satisfy
   * proof-only closeout; a later authenticated report still upgrades it with
   * the reported result. A failed, gap-ridden or inconclusive timeline read
   * settles nothing, and a run that can still report or already settled stays
   * untouched. Returns how many records settled.
   */
  async settleHistoricalProofExecutions(taskId: string, detail: string): Promise<number> {
    let settled = 0;
    if (this.store.task(taskId).removedAt) return settled;
    for (const run of this.store.runs(taskId)) {
      if (settlementHeld(this.store, this.stopped)) return settled;
      if (run.role !== "executor" || !run.proofExecution) continue;
      const record = (this.store.task(taskId).proofExecutions ?? []).find(item => item.runId === run.id);
      if (!record || record.status !== "running") continue;
      if (!run.released && !supersededIdleBinding(this.store, taskId, run).superseded) continue;
      if (!run.agentId || !this.adapter.agentTimelinePage) continue;
      let read: Awaited<ReturnType<typeof readToolTimeline>>;
      try { read = await readToolTimeline(this.engine.host, run.agentId); }
      catch { continue; }
      if (!("entries" in read)) continue;
      const ran = timelineSelectorEvidence(read.entries, run.proofExecution.selector);
      if (!ran) continue;
      this.store.transaction(() => {
        const fresh = this.store.run(run.id);
        const binding = fresh?.proofExecution;
        if (!fresh || !binding || fresh.completion) return;
        const current = this.store.task(taskId);
        const running = (current.proofExecutions ?? []).find(item => item.runId === run.id);
        if (!running || running.status !== "running") return;
        recordProofExecution(this.store, taskId,
          { ...running, status: "unknown", historical: true, exitCode: null, selectorStart: "started",
            selectorStartEvidence: `Tool timeline: declared selector invoked at ${ran.at}`,
            evidence: `Timeline-only evidence: the selector ran as shell command "${ran.command}" (terminal at ${ran.at}); no result was ever reported (${detail})`.slice(0, 4000) },
          `${run.id}: timeline shows the selector ran at ${fresh.head}; settled as historical evidence, never a pass and no allowance spent`);
        this.store.event(taskId, "proof_execution_historical",
          `${run.id}: timeline-only evidence settles the execution record as unknown for ${binding.selector} at ${fresh.head}; it ran, no result was reported, and it is never a pass (${detail})`);
        settled++;
      });
    }
    return settled;
  }

  /**
   * Why one binding-superseded run must stay held, or null when it is
   * observably idle with its safeguards passing. Observation is fresh, never
   * from stored flags: the same agent in the run's workspace, idle with no
   * active turn and no pending permission, no live owned tool by the existing
   * timeline proof unless native closure already ended the managed session,
   * and no ambiguous or uncertain effect on the run. A hold
   * writes nothing.
   */
  async supersededIdleFence(run: Run): Promise<string | null> {
    let state: Awaited<ReturnType<Adapter["observe"]>> | null = null;
    try { state = await this.engine.host.observe(run.agentId!); }
    catch {
      // A thread its host reports archived or gone is the stopped proof the
      // ordinary archive path accepts, so an unreadable live observation no
      // longer holds it. Anything weaker stays unobservable and held.
      if (!await this.threadArchivedOrGone(run.agentId!)) return "its agent is unobservable";
    }
    if (state) {
      if (!state.id || state.id !== run.agentId) return "its agent is unreadable";
      if (state.workspaceId !== run.workspaceId) return "its agent is outside the run workspace";
      if (state.active || state.activeTurnId) return "its agent is active";
      if (state.permissions) return "its agent is awaiting a permission request";
      if (!["idle", "error", "closed"].includes(state.status)) return `its agent is ${state.status}`;
      if (state.status !== 'closed') {
        const tools = await this.engine.ownedToolHold(run.agentId!, run.id, run.taskId);
        if (tools) return tools;
      }
    }
    // The archive proves the thread cannot take a turn; it never settles the
    // run's durable effects, which keep their own fence.
    const refusal = blockingRecoveryEffectsRefusal(this.store, this.store.task(run.taskId), { runId: run.id });
    if (refusal) return refusal;
    return null;
  }

  /** The host's own answer that this thread is archived or gone; an unreadable one proves nothing. */
  async threadArchivedOrGone(agentId: string): Promise<boolean> {
    try {
      const origin = await this.engine.host.originAgent(agentId);
      return !origin || origin.archived === true;
    } catch { return false; }
  }

  /**
   * The existing owned-tool proof (Spec 016 stopped-run coverage): no live
   * tool by timeline evidence. An adapter without a timeline offers no owned
   * tool to hold on; where the timeline exists, inconclusive evidence holds.
   * A running entry is settled once the same agent's own fresh observation
   * proves no turn is live and the call's kind cannot outlive its turn. A shell
   * call additionally needs a complete provider process-tree proof rooted at
   * this run's MCP report helper; every unreadable or live descendant holds.
   */
  async ownedToolHold(agentId: string, runId?: string, taskId?: string): Promise<string | null> {
    if (!taskId || !runId) return this.resolution.ownedToolHold(agentId);
    const task=this.store.task(taskId), runs=this.store.runs(taskId);
    const boundRun=runs.find(run=>run.id===runId);
    const workspaceId=boundRun?.workspaceId ?? task.workspaceId;
    if (!workspaceId) return 'owned tool run workspace identity is unavailable';
    const runIds=participantToolRunIds(task,runs,agentId,workspaceId);
    if (!runIds.includes(runId)) runIds.unshift(runId);
    return this.resolution.ownedToolHold(agentId,{runId,runIds,taskId,workspaceId});
  }

  /**
   * Spec 050 observed liveness: whether one run's agent is live right now. Live
   * means the agent is active, holds an active turn, is awaiting a permission, or
   * is observed outside the run's workspace. An unobservable agent is live,
   * because a failed observation is never proof of death. `null` means the run
   * has no bound agent, so there is nothing to observe and the stored `active`
   * and `idleSince` flags decide nothing.
   */
  async observedRunLiveness(run: Run): Promise<boolean | null> {
    if (!run.agentId) return null;
    let state: Awaited<ReturnType<Adapter["observe"]>>;
    try { state = await this.engine.host.observe(run.agentId); } catch { return true; }
    if (state.workspaceId !== run.workspaceId) return true;
    return state.active || Boolean(state.activeTurnId) || state.permissions
      || !["idle", "error", "closed"].includes(state.status);
  }
}
