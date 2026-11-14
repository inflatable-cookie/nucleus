import { randomUUID } from 'node:crypto';
import type { Incident, Run, Task } from '../../shared/contracts';
import type { IncidentCause } from '../../shared/incident';
import { DISPATCH_WAIT_REASON, isTransientExternalFailure, taskStopClassification, taskStopRecord, taskStopVerbsFor, type TaskStopReason, type TaskStopVerb } from '../../shared/task-stop';
import { NUCLEUS_HELD_REFUSAL_EVENTS, nucleusHeldReason, taskBudget, type BudgetClock } from '../../shared/task-budget';
import { TASK_PROGRESSING_REASON } from '../../shared/task-detail-summary';
import { holdsOf } from '../../shared/holds';
import { incidentKey } from './incident';
import { isRepositoryContention, repositoryContentionNeedsAttention } from '../scheduling/repository-contention';
import type { Resolution } from '../resolution';
import { digest, now } from '../store/store';
import { EXTERNAL_MERGE_CHECK_REASON_PREFIX, noActionEscalationAtAcceptedHead, visibleTaskReason, workingLanes } from './task-reasons';

/** Task fields that must never ride in a resolution-changes object. Building that
 * object in a variable bypasses TypeScript's excess-property check, which is how
 * project-a #1984 left `prHead` unmoved after a work stage pushed a new head. */
type TaskOnlyKey = Exclude<keyof Task, keyof Task['resolution'] | 'resolution'>;
type ResolutionChanges = Partial<Task['resolution']> & { [K in TaskOnlyKey]?: never };
export type { ResolutionChanges };

/**
 * Writes a task's stops, incidents and attention. Same-name `Resolution` methods
 * delegate here and cross-method calls go through the public ones, so instance
 * overrides still fire. `store` reads the resolution per call.
 */
export type TaskStopsContext = Pick<Resolution, 'ensureIncident' | 'questions' | 'recordIncidentEvent' | 'saveIncident' | 'settleAttentionEpisode' | 'stopped' | 'store' | 'update' | 'waiting'>;

export class TaskStops {
  constructor(readonly resolution: TaskStopsContext) {}
  get store() { return this.resolution.store; }

  update(t: Task, changes: ResolutionChanges, patch: Partial<Task> = {}, event = 'resolution', detail?: string) {
    const current = this.store.task(t.id);
    const reasonOrPhaseChanged = patch.reason !== undefined && patch.reason !== current.reason
      || patch.phase !== undefined && patch.phase !== current.phase;
    const stop = changes.stop !== undefined ? changes.stop : reasonOrPhaseChanged ? null : current.resolution.stop;
    return this.store.update(t.id, { ...patch, resolution: { ...current.resolution, ...changes, stop } }, event, detail ?? patch.reason ?? patch.phase ?? event);
  }
  /**
   * Spec 058 budgets (nucleus#1153): charge the wall clock for the task's own work
   * only. Called once per task quantum and once per task visit in the sweep — the
   * two places that observe every live task each pass — it opens a pause interval
   * while the task is held for a Nucleus-side cause and closes it when the task can
   * make progress again, so the budget is not spent on Nucleus's downtime.
   * Intervals are durable on the task (`resolution.budgetClock`) and recorded as
   * events for the board's telemetry; the budget read subtracts them.
   *
   * A wedged or failed sweep is one cause: the sweep records `observation_outage`
   * when a task quantum overruns its bound. An interval opened for an outage is
   * dated from that observation, not from the visit that noticed it, so the whole
   * outage is discounted whether a sweep visit or the returned quantum gets there
   * first. Only `options.returned` (the wedged quantum's own finish) closes it, with
   * `observation_resumed`: a sweep visiting a still-running lane never claims it
   * returned.
   */
  settleBudgetClock(task: Task, options: { returned?: boolean } = {}): Task {
    const current = this.clearPassedBudgetStop(this.store.task(task.id));
    const at = Date.parse(now());
    const clock: BudgetClock = current.resolution.budgetClock ?? { pausedMs: 0, pauses: 0, since: null, reason: null };
    const terminal = current.phase === 'done' || current.phase === 'cancelled';
    const events = this.store.eventsAll(current.id);
    // The earliest outage the lane has not yet returned from; repeated observations
    // of one wedged quantum never move its start forward.
    const resumedAt = events.findLastIndex(event => event.kind === 'observation_resumed');
    const outageAt = events.findIndex((event, index) => index > resumedAt && event.kind === 'observation_outage');
    const outage = outageAt >= 0 ? events[outageAt]!.at : null;
    // A proven pre-send refusal holds the task while the attention it set is still
    // the current episode: an owner resume writes `attention_episode_resolved`. The
    // task's own reason is checked too, so a later, different fault can never read
    // as a stale refusal.
    const refusalAt = events.findLastIndex(event => (NUCLEUS_HELD_REFUSAL_EVENTS as readonly string[]).includes(event.kind));
    const presendRefusal = refusalAt >= 0 && refusalAt > events.findLastIndex(event => event.kind === 'attention_episode_resolved')
      && current.resolution.attention === true && /refused before send/i.test(current.reason);
    const closingOutage = Boolean(outage) && Boolean(options.returned);
    // The task's own host wait is a Nucleus-side cause of its own (nucleus#1198
    // review): it pauses the clock whether or not the stop beside it belongs to
    // an owner answer, and the interval is dated from the outage's start.
    const hostWait = current.resolution.hostWait ?? null;
    const held = terminal ? null : nucleusHeldReason({
      stopReason: current.resolution.stop?.reason ?? null,
      dispatchHeld: Boolean(holdsOf(current).dispatch),
      incidentCause: current.resolution.incident && current.resolution.incident.status !== 'resolved'
        ? current.resolution.incident.cause : null,
      presendRefusal,
      hostWaitSince: hostWait?.since ?? null,
      // While the lane is wedged only the outage may hold it; the returned quantum
      // has to be able to close the interval.
      observationOutage: Boolean(outage) && !closingOutage,
    });
    const opening = !clock.since && Boolean(held);
    const running = Boolean(clock.since);
    // Nothing to close and nothing to open: the usual pass writes nothing.
    if (running && held && !closingOutage) return current;
    if (!running && !held && !closingOutage) return current;
    // A segment closes when its cause ends or when its outage returns. Its start is
    // the open `since`, and for an outage the observation itself — so an interval
    // opened for an outage is dated from the observation, and a return that beats
    // every visit still books the outage time.
    const starts = [clock.since, outage, hostWait?.since]
      .map(value => (value ? Date.parse(value) : Number.NaN))
      .filter(started => Number.isFinite(started) && started <= at);
    const pausedTo = starts.length ? Math.min(...starts) : at;
    const next: BudgetClock = opening
      // An interval that starts now books nothing yet; an outage one is dated from
      // the observation that caused it, so the read discounts it immediately.
      ? { ...clock, since: new Date(starts.length ? pausedTo : at).toISOString(), reason: held }
      : {
          pausedMs: clock.pausedMs + Math.max(0, at - pausedTo),
          pauses: clock.pauses + (starts.length ? 1 : 0),
          since: held ? new Date(at).toISOString() : null,
          reason: held,
        };
    const detail = opening
      ? `${held}; the wall-time budget stops until the task can make progress again`
      : `the task can make progress again; ${Math.round(next.pausedMs / 60_000)} minutes of wall time stayed off its budget`;
    return this.store.transaction(() => {
      // A Queue-owned record: it spends no task version (Store.setBudgetClock).
      const updated = this.store.setBudgetClock(current.id, next);
      this.store.event(current.id, opening ? 'budget_clock_paused' : 'budget_clock_resumed', detail);
      if (closingOutage) this.store.event(current.id, 'observation_resumed', `the task quantum returned after ${outage}; its lane moves again`);
      return updated;
    });
  }
  /**
   * Clear one task's host wait when its host is back (Tom, 2026-11-14; T3 lane
   * v18, host dropout option 1: wait). Nothing about the task's identity, host or
   * threads changes; the next pass re-proves each retained thread and the task
   * continues where it was. The independent wait is always cleared; the stop is
   * cleared only when the wait wrote it, so an owner-facing stop keeps its
   * question and its bookkeeping.
   */
  clearHostWait(task: Task): Task {
    const current = this.store.task(task.id);
    const hadWait = Boolean(current.resolution.hostWait);
    const hostStop = current.resolution.stop?.reason === 'host_unavailable';
    if (!hadWait && !hostStop) return current;
    const reason = hostStop ? current.phase === 'queued' ? DISPATCH_WAIT_REASON : TASK_PROGRESSING_REASON : current.reason;
    const detail = `Host ${current.hostId ?? 'unknown'} is back; the task resumes on the same host and threads`;
    return this.resolution.update(current, { hostWait: null, ...(hostStop ? { stop: null } : {}) },
      hostStop ? { reason } : {}, 'host_outage_resumed', detail);
  }
  /**
   * Spec 058 budgets (nucleus#1187): a recorded `budget` stop is a fence like any
   * other, so it may only stand while the measurement it names still shows the
   * pause. A changed measurement — a converted task's first recorded run, a
   * corrected clock, records that no longer add up to the limit — clears it here,
   * in the pass that already reads the task's runs and events, together with the
   * budget question it raised. Otherwise the dispatcher would refuse a task the
   * views read as progressing, and the board would ask about a pause that is gone.
   */
  clearPassedBudgetStop(task: Task): Task {
    if (task.resolution.stop?.reason !== 'budget' || ['done', 'cancelled'].includes(task.phase)) return task;
    const budget = taskBudget(task, this.store.runs(task.id), Date.now(), this.store.eventsAll(task.id),
      this.store.canonicalRepository(task.repoPath, task.repository));
    if (budget.exhausted) return task;
    // A queued task's own wait is dispatch; every other phase is progressing under
    // whatever it was doing, so the pause's text never survives as the reason.
    const reason = task.phase === 'queued' ? DISPATCH_WAIT_REASON : TASK_PROGRESSING_REASON;
    const detail = `The measured budget no longer shows the pause: ${Math.round(budget.wallMs.used / 60_000)} of ${budget.wallMs.limit / 60_000} minutes and ${budget.effectiveTokens.used} of ${budget.effectiveTokens.limit} effective tokens; the task's budget does not stop it`;
    const cleared = this.store.transaction(() => {
      const latest = this.store.task(task.id);
      if (latest.resolution.stop?.reason !== 'budget') return null;
      return this.resolution.update(latest, { stop: null }, { reason }, 'budget_pause_cleared', detail);
    });
    if (!cleared) return this.store.task(task.id);
    // The question answers to the same figure: the pause is gone, so its recorded
    // question is superseded and dismissed rather than left waiting for an answer.
    this.resolution.questionSupersession.supersedeBudgetQuestions(task.id, 'The measured budget no longer shows the pause.');
    return cleared;
  }
  /** Record one stop or wait on the task; matching observations retain their first timestamp. */
  recordStop(task: Task, reason: TaskStopReason, detail: string, suggestedVerbs?: TaskStopVerb[], phase?: Task['phase']): Task {
    const current = this.store.task(task.id);
    // A queued task's capacity wait names the in-flight list, which changes with every
    // transition. Rewriting ~100 queued rows and events each time pinned the service at
    // 100% CPU (2026-11-04). A task already waiting on capacity keeps its record; the
    // board computes the live wait, and dispatch re-reads admission for itself.
    if (reason === 'capacity' && current.phase === 'queued' && (!phase || phase === current.phase)
      && current.resolution.stop?.reason === 'capacity') return current;
    const stop = taskStopRecord(reason, detail, current.resolution.stop, now(), suggestedVerbs);
    const visible = visibleTaskReason(detail, stop);
    if (JSON.stringify(stop) === JSON.stringify(current.resolution.stop) && current.reason === visible && (!phase || phase === current.phase)) return current;
    return this.resolution.update(current, { stop }, { reason: visible, ...(phase ? { phase } : {}) }, 'task_stopped', JSON.stringify(stop));
  }
  /** Upsert the deduplicated incident for a fault; repeated observations update the same row. */
  ensureIncident(task: Task, run: Run | null, reason: string, action: Incident['action'] = '', cause?: IncidentCause): Incident {
    const current = this.store.task(task.id);
    const key = incidentKey(current, run, reason, this.store.runs(current.id), cause);
    const prior = current.resolution.incident;
    const priorFingerprint = prior?.fingerprint || prior?.id;
    if (prior && priorFingerprint === key.id && prior.status !== 'resolved') {
      if (prior.status !== 'escalated' && prior.detail !== reason) this.resolution.saveIncident(current, { detail: reason.slice(0, 2000) });
      return this.store.task(current.id).resolution.incident!;
    }
    // Attempt counts stay informational here; replacement budgets are decided from durable replacement events.
    const attempt = prior && prior.role === key.role && prior.cause === key.cause ? prior.attempt : 0;
    const incident: Incident = { id: priorFingerprint === key.id ? digest(`${key.id}:${randomUUID()}`) : key.id, fingerprint: key.id, role: key.role, runId: key.runId, turnId: null, attempt, cause: key.cause, detail: reason.slice(0, 2000), action, status: 'reconciling', createdAt: now(), updatedAt: now() };
    this.resolution.update(current, { incident }, {}, 'incident_recorded');
    this.resolution.recordIncidentEvent(current.id, incident);
    return incident;
  }
  recordIncidentEvent(taskId: string, incident: Incident) {
    this.store.event(taskId, 'incident', JSON.stringify({ id: incident.id, role: incident.role, runId: incident.runId, attempt: incident.attempt, cause: incident.cause, action: incident.action, status: incident.status }));
  }
  saveIncident(task: Task, patch: Partial<Incident>) {
    const current = this.store.task(task.id);
    const incident = current.resolution.incident;
    if (!incident) return;
    const next = { ...incident, ...patch, updatedAt: now() };
    this.resolution.update(current, { incident: next });
    if (next.status !== incident.status || next.action !== incident.action || next.attempt !== incident.attempt) this.resolution.recordIncidentEvent(current.id, next);
  }
  /** Mark the incident for a run resolved; escalated incidents stay with their coordinator. */
  resolveIncident(task: Task, runId: string | null, detail: string) {
    const current = this.store.task(task.id);
    const incident = current.resolution.incident;
    if (!incident || incident.runId !== runId || incident.status === 'escalated') return;
    if (incident.status === 'resolved' && incident.detail === detail) return;
    this.resolution.saveIncident(current, { status: 'resolved', detail: detail.slice(0, 2000) });
  }
  /**
   * Supersede the pending attention notices of an episode that is closed and
   * record the closure once. Shared by every operator-return path and by the
   * answered-escalation resolution, so settling always uses one behaviour.
   */
  settleAttentionEpisode(taskId: string, detail: string) {
    for (const notice of this.store.notices(taskId)) {
      if (notice.kind === 'attention' && notice.status === 'pending') this.store.putNotice({ ...notice, status: 'superseded', error: detail });
    }
    this.store.event(taskId, 'attention_episode_resolved', detail);
    const current = this.store.task(taskId);
    if (current.resolution.externalMergePreAttention) this.resolution.update(current, { externalMergePreAttention: null }, {}, 'external_merge_pre_attention_cleared');
  }
  /** Close an operator-resolved attention episode before returning the task to work. */
  operatorReturn(t: Task, changes: ResolutionChanges, patch: Partial<Task>, event: string, detail: string, eventDetail?: string) {
    const current = this.store.task(t.id), prior = current.resolution.incident;
    if (current.resolution.recovery) this.store.event(t.id, 'recovery_episode_superseded', JSON.stringify(current.resolution.recovery));
    const incident = prior ? { ...prior, fingerprint: prior.fingerprint || prior.id, status: 'resolved' as const, detail, updatedAt: now() } : null;
    const next = this.resolution.update(current, { ...changes, incident, recovery: null, recoveryActive: false, recoveryAttempts: 0 }, patch, event, eventDetail);
    if (prior && prior.status !== 'resolved') this.resolution.recordIncidentEvent(current.id, incident!);
    this.resolution.settleAttentionEpisode(current.id, detail);
    return next;
  }
  /** Called only after the operator retry has proved settled initial dispatch state. */
  returnToDispatch(t: Task, retainedWorkspace: boolean, reason: string, event = 'retry_validation'): Task {
    return this.operatorReturn(t, { attention: false },
      { phase: 'queued', workspaceIntent: retainedWorkspace, reason }, event, reason);
  }
  /**
   * True while an escalated episode is still backed by work Queue will advance.
   * An in-flight recovery or an unlanded merge owns the lane. A recovery's
   * no-action finding at an accepted reviewed head has no resolution action to
   * retry; answering it lets the existing verification gate run (Spec 016 rule 6).
   */
  escalationLiveWork(t: Task): string | null {
    if (t.resolution.recoveryActive) return 'a recovery action is active';
    if (t.resolution.mergeIntent && !t.resolution.mergedCommit) return 'an unlanded merge intent is pending';
    if (noActionEscalationAtAcceptedHead(t)) return null;
    const liveLaneWork: Partial<Record<Task['phase'], string>> = {
      dispatching: 'worker dispatch is in progress', working: 'worker work is in progress',
      awaiting_review: 'review is pending', reviewing: 'reviewer work is in progress',
      changes_requested: 'revision work is pending', verifying: 'pre-merge verification is pending',
      merging: 'merge work is in progress', syncing: 'main synchronization is in progress', closing: 'closeout work is in progress',
    };
    if (workingLanes.has(t.phase)) return `${liveLaneWork[t.phase] ?? 'task work is in progress'} (phase ${t.phase})`;
    if (t.phase === 'done' || t.phase === 'cancelled') return null;
    // A different incident identity is the record of the escalated incident
    // having been superseded by the task's later fault. The escalation's own
    // status is not evidence that the task still has a fault to work.
    const recovery = t.resolution.recovery;
    const currentFault = t.resolution.attention || ['blocked', 'error', 'needs_attention'].includes(t.phase);
    return currentFault && (!recovery?.incidentId || recovery.incidentId === t.resolution.incident?.id)
      ? `the ${t.phase} task still has an unresolved attention fault`
      : null;
  }
  /**
   * Operator-only closure of an escalation whose question has been answered
   * (Spec 016 rule 6). The authority is the caller: only the versioned operator
   * control passes `operator`, so no coordinator recovery, notice route or
   * automatic pass can reach this mutation. The escalated recovery and incident
   * move to `resolved` with the operator's reason, the `recovery_escalated`
   * event and its summary stay intact as history, pending attention notices
   * settle and attention clears through the ordinary episode closure. It never
   * changes the task's phase: answering the escalation does not decide the task.
   */
  resolveEscalation(t: Task, reason: string, operator = false): Task {
    if (!operator) throw new Error('Resolving an escalation is operator-only; no automatic or coordinator path holds this authority');
    const answer = reason.trim();
    if (!answer) throw new Error('Resolving an escalation requires the operator reason that answered it');
    const apply = () => {
      const current = this.store.task(t.id);
      if (current.removedAt) throw new Error('Task was removed from the queue');
      const priorRecovery = current.resolution.recovery, priorIncident = current.resolution.incident;
      const escalatedRecovery = priorRecovery?.status === 'escalated' ? priorRecovery : null;
      const escalatedIncident = priorIncident?.status === 'escalated' ? priorIncident : null;
      if (!escalatedRecovery && !escalatedIncident) throw new Error('No escalated recovery or incident is awaiting an answer');
      const unreleasedRun = this.store.runs(t.id).find(run => !run.released);
      if (unreleasedRun) throw new Error(`An unreleased ${unreleasedRun.role} run still owns this task; settle that run before resolving the escalation`);
      const liveWork = this.escalationLiveWork(current);
      if (liveWork) throw new Error(`The escalation is still backed by live work: ${liveWork}; stop or finish it before resolving the escalation`);
      const detail = `Escalation answered by the operator: ${answer}`.slice(0, 2000);
      const incident = escalatedIncident ? { ...escalatedIncident, status: 'resolved' as const, detail, updatedAt: now() } : priorIncident;
      const recovery = escalatedRecovery ? { ...escalatedRecovery, status: 'resolved' as const } : priorRecovery;
      const next = this.resolution.update(current, { attention: false, incident, recovery, recoveryActive: false }, {}, 'escalation_resolved');
      if (escalatedIncident) this.resolution.recordIncidentEvent(current.id, incident!);
      this.resolution.settleAttentionEpisode(current.id, detail);
      return next;
    };
    return this.store.db.isTransaction ? apply() : this.store.transaction(apply);
  }
  /** Raise attention for a fault. `cause` names the incident cause; without it the reason text is classified. */
  attention(t: Task, reason: string, cause?: IncidentCause) {
    const current = this.store.task(t.id);
    if (isRepositoryContention(reason) && !repositoryContentionNeedsAttention(this.store, current, reason)) {
      this.resolution.waiting(current, reason, 'lifecycle');
      return;
    }
    // A read-only GitHub or git probe that hit a forge 5xx or a truncated
    // response clears on its own; the next task quantum probes again. It is a
    // wait, never an incident, a park or a coordinator run (lean audit
    // 2026-10-15: 17 needs_attention episodes in two days were GitHub 5xx).
    if (isTransientExternalFailure(reason)) {
      this.resolution.waiting(current, reason, 'external_unavailable');
      return;
    }
    const run = current.resolution.currentRunId ? this.store.run(current.resolution.currentRunId) : null;
    if (current.resolution.attention && current.resolution.recovery?.status==='escalated' &&
        current.reason !== reason && current.resolution.incident?.runId === (run?.id ?? current.runId)) {
      // Keep the first unresolved fault as the task reason. Record a second
      // fault once for inspection without replacing the incident every pass.
      if (!this.store.events(t.id).some(e => e.kind === 'concurrent_fault' && e.detail === reason))
        this.store.event(t.id, 'concurrent_fault', reason);
      return;
    }
    this.resolution.ensureIncident(current, run, reason, '', cause);
    // A fault that leaves the task with no live run owner has no supported
    // recovery control on a working phase, so it lands in `needs_attention`.
    // This is the same window the `stoppedBeforeCallback` recovery gate already
    // describes: no completion, no PR identity and no current run. Attention
    // that still holds a live run (a reviewer callback reminder, a repository
    // pre-merge gate) keeps its phase and carries attention
    // only.
    const ownerless = !current.completion && !current.resolution.currentRunId &&
      !current.prUrl && !current.prHead && !current.resumePrNumber;
    if (current.resolution.attention && current.reason === reason && !(ownerless && current.phase !== 'needs_attention')) return;
    // A transient external-merge probe can park a task that was already in
    // needs_attention (the accepted-PR reconciliation) with no run to advance it.
    // Remember the phase and reason it held so the recovery tick can resume it
    // rather than clearing the flag onto a stranded phase (project-a #1837).
    const preAttention = reason.startsWith(EXTERNAL_MERGE_CHECK_REASON_PREFIX) && !current.resolution.attention
      ? { externalMergePreAttention: { phase: current.phase, reason: current.reason } }
      : {};
    const classification = taskStopClassification(reason);
    const stop = taskStopRecord(classification.reason, reason, current.resolution.stop, now(), classification.suggestedVerbs);
    this.resolution.update(current, { attention: true, stop, ...preAttention }, { reason, ...(ownerless ? { phase: 'needs_attention' as const } : {}) }, 'needs_attention');
  }
  /**
   * Record a wait. Every Queue caller names its stop reason: classifying its own
   * free text was fragile (a reworded message changed what the task was waiting
   * for). `classify` is only for restoring a reason Queue did not just author.
   */
  waiting(t: Task, reason: string, stop: TaskStopReason | 'classify', suggestedVerbs?: TaskStopVerb[]) {
    const current = this.store.task(t.id);
    // A newly launched run is ordinary forward progress, not a task stop.
    // Keep its visible lifecycle reason while clearing any prior stop record.
    if (/\bthread running$/.test(reason) || reason === 'Worker running') {
      if (current.reason !== reason || current.resolution.stop !== null)
        this.resolution.update(current, { stop: null }, { reason }, 'task_waiting', reason);
      return;
    }
    const classification = stop === 'classify' ? taskStopClassification(reason) : { reason: stop, suggestedVerbs: taskStopVerbsFor(stop) };
    const retainedSuggestions = classification.reason === 'escalated' && current.resolution.stop?.reason === 'escalated'
      ? current.resolution.stop.suggestedVerbs : classification.suggestedVerbs;
    const record = taskStopRecord(classification.reason, reason, current.resolution.stop, now(), suggestedVerbs ?? retainedSuggestions);
    const visible = visibleTaskReason(reason, record);
    // Compare against what this writes. The stop detail is capped at 4000
    // characters; the task reason keeps the full text, in the one form every stop
    // writer uses, so neither a repeat (consumer #658) nor a different writer
    // recording the same long text (consumer #660, recordStop) rewrites the task.
    if (current.reason === visible && JSON.stringify(current.resolution.stop) === JSON.stringify(record)) return;
    this.resolution.update(current, { stop: record }, { reason: visible }, 'task_waiting', JSON.stringify(record));
  }
  recordDeferredDuringPrerequisiteWait(task: Task, kind: 'transport_deferred' | 'environment_deferred', detail: string): boolean {
    const current = this.store.task(task.id);
    if (!(current.prerequisiteWait && !current.prerequisiteWait.releasedAt) && !this.store.dependencyWait(current)) return false;
    if (!this.store.events(current.id).some(event => event.kind === kind && event.detail === detail)) this.store.event(current.id, kind, detail);
    return true;
  }
  /** A host outage must not replace a retained task decision with a retry instruction. */
  transportDeferred(t: Task, error: unknown) {
    // A stopping owner closes its own Paseo client before its in-flight work quiesces
    // (drain), so a failure now is the owner leaving, not the daemon. The store stays
    // open until drain ends, so a write here outlives the owner as a stale wait that the
    // successor shows until its first pass. The successor observes the daemon itself.
    if (this.resolution.stopped()) return;
    const current = this.store.task(t.id);
    const detail = `Daemon transport unavailable; retrying on the next pass: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`;
    if (this.recordDeferredDuringPrerequisiteWait(current, 'transport_deferred', detail)) return;
    if (['needs_attention', 'blocked', 'error'].includes(current.phase) || current.resolution.attention || current.resolution.recovery?.status === 'escalated') {
      if (this.store.events(t.id).find(event => event.kind === 'transport_deferred')?.detail !== detail)
        this.store.event(t.id, 'transport_deferred', detail);
      return;
    }
    this.resolution.waiting(current, detail, 'external_unavailable');
  }
  /** A dead login session is a host fault: drain/replace the service, never park the task. */
  environmentDeferred(t: Task, error: unknown) {
    const current = this.store.task(t.id);
    const detail = `Host login session is gone; replacing the Nucleus service rather than charging this task: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`;
    if (this.recordDeferredDuringPrerequisiteWait(current, 'environment_deferred', detail)) return;
    if (['needs_attention', 'blocked', 'error'].includes(current.phase) || current.resolution.attention || current.resolution.recovery?.status === 'escalated') {
      if (this.store.events(t.id).find(event => event.kind === 'environment_deferred')?.detail !== detail)
        this.store.event(t.id, 'environment_deferred', detail);
      return;
    }
    this.resolution.waiting(current, detail, 'external_unavailable');
  }
}
