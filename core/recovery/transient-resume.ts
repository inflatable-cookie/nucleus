import type { Profile, Run, Task, TransientProviderRetry } from '../../shared/contracts';
import { isDispositionActive, isDispositionComplete, workerProfileIsExcluded } from '../../shared/contracts';
import { requestOnly, groupIsUnavailable } from '../../shared/pool';
import { steppedDelay } from '../../shared/backoff';
import { escalationWaitDetail, plannerEscalations, type LadderEvent } from '../questions/blocker-ladder';
import { dispatchBlocked } from '../dispatch/capacity';
import { TRANSIENT_BACKOFF_MS, TRANSIENT_MAX_RESUMES, isQuotaExhaustion, isRateLimitError, isTransientProviderError, rateLimitCooldownData, transientProviderRetryAt } from './exhaustion';
import { interactiveSessionOpen } from '../dispatch/interactive';
import type { Adapter } from '../host/adapter';
import type { Resolution } from '../resolution';
import { reviewAuthorizationRequired } from '../review/review-continuation';
import { chooseProfile } from '../dispatch/routing';
import { digest, now } from '../store/store';
import { ProvenPreSendRefusalError, TRANSIENT_PROVIDER_WAIT, active, coordinative } from './task-reasons';

/** First decision for a retained provider observation. Later send and retry gates
 * are evaluated only after their preceding effects have settled. */
export function transientResumeDecision(busy: boolean, status: string, retryStatus: TransientProviderRetry['status'] | undefined, quota: boolean):
  'busy' | 'settled' | 'quota' | 'uncertain' | 'exhausted' | 'sent' | 'schedule' {
  if (busy) return 'busy';
  if (status !== 'error') return 'settled';
  if (quota) return 'quota';
  if (retryStatus === 'intent' || retryStatus === 'uncertain') return 'uncertain';
  if (retryStatus === 'exhausted') return 'exhausted';
  if (retryStatus === 'sent') return 'sent';
  return 'schedule';
}

/** Decision after a previously sent continuation reports another error. */
export function transientSentDecision(transient: boolean, oldErrorStillVisible: boolean, resumes: number): 'failed' | 'wait' | 'exhausted' | 'schedule' {
  if (!transient) return 'failed';
  if (oldErrorStillVisible) return 'wait';
  if (resumes >= TRANSIENT_MAX_RESUMES) return 'exhausted';
  return 'schedule';
}

/** Decision once a retry has a durable waiting record. */
export function transientWaitingDecision(beforeRetryAt: boolean, resumes: number, canSend: boolean): 'wait' | 'exhausted' | 'no_channel' | 'send' {
  if (beforeRetryAt) return 'wait';
  if (resumes >= TRANSIENT_MAX_RESUMES) return 'exhausted';
  return canSend ? 'send' : 'no_channel';
}

/** Same-thread provider retry for a retained run and for the initial worker, with its rate-limit failover. */
export type TransientResumeContext = Pick<Resolution, 'adapter' | 'attention' | 'graceMs' | 'host' | 'onTaskHost' | 'openPlannerEscalation' | 'paused' | 'profiles' | 'store' | 'update' | 'waiting'>;

export class TransientResume {
  constructor(readonly resolution: TransientResumeContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  get profiles() { return this.resolution.profiles; }
  get graceMs() { return this.resolution.graceMs; }
  paused() { return this.resolution.paused(); }
  update(...args: Parameters<Resolution['update']>) { return this.resolution.update(...args); }
  attention(...args: Parameters<Resolution['attention']>) { return this.resolution.attention(...args); }
  waiting(...args: Parameters<Resolution['waiting']>) { return this.resolution.waiting(...args); }
  openPlannerEscalation(...args: Parameters<Resolution['openPlannerEscalation']>) { return this.resolution.openPlannerEscalation(...args); }

  /**
   * A transient provider wait holds while any of the task's threads still has a
   * pending transient retry (waiting, intent, or sent with no progress seen).
   * This producer clears its own wait once none does: recovery leaves waits on
   * progressing work alone. Other provider waits and failover's are not its own.
   */
  clearResumedProviderWait(taskId: string): void {
    const current = this.store.task(taskId), stop = current.resolution.stop;
    if (stop?.reason !== 'provider_unavailable' || !stop.detail.startsWith(TRANSIENT_PROVIDER_WAIT) || current.failoverReason) return;
    const pending = (retry?: TransientProviderRetry) => Boolean(retry && (retry.status === 'waiting' || retry.status === 'intent' || (retry.status === 'sent' && !retry.sawProgress)));
    if (pending(current.transientProviderRetry) || this.store.runs(taskId).some(run => !run.released && pending(run.transientProviderRetry))) return;
    this.update(current, { stop: null }, {}, 'task_wait_cleared', 'provider_unavailable');
  }
  /**
   * Task 646: record a rate-limited provider group in capacity state so new
   * launches prefer other eligible profiles meanwhile. The row is a short
   * cool-down (the provider's own retry time when given, else five minutes),
   * never a durable exhaustion mark: `groupIsUnavailable` releases it on
   * expiry and selection avoids the group only until then.
   */
  recordRateLimitCooldown(group: string | null | undefined, error: string): void {
    if (!group || !isRateLimitError(error)) return;
    const row = this.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get(group) as { data: string } | undefined;
    this.store.setAvailability(group, rateLimitCooldownData(row?.data, error, group));
  }

  /**
   * Task 646: after the backoff schedule is used up, a rate-limit error routes
   * to another eligible profile at the same capability (an allowed model
   * change, Spec 057) instead of parking. Returns the replacement, or null
   * when no alternate exists so the caller escalates to the planner, never to
   * operator-needed first.
   */
  selectRateLimitFailover(task: Task) {
    const old = task.profile;
    const pool = this.store.pool();
    const oldEntry = old ? pool.find(entry => entry.profileId === old.id) : undefined;
    const oldGroup = oldEntry?.group ?? task.profileGroup ?? null;
    const unavailable = new Set(this.store.db.prepare('SELECT data FROM availability').all().flatMap(row => {
      const state = JSON.parse(String((row as { data: string }).data));
      return groupIsUnavailable(state) ? [state.group as string] : [];
    }));
    // The exhausted subscription group is out, not the whole provider: a
    // different eligible group on the same provider still qualifies, with a
    // different provider preferred so one provider's burst spreads.
    const eligible = this.profiles().filter(candidate =>
      (!old || candidate.id !== old.id)
      && !workerProfileIsExcluded(task, candidate.id)
      && pool.some(entry => entry.profileId === candidate.id
        && (oldEntry?.capability ? entry.capability === oldEntry.capability : true)
        && entry.cost !== 'very_high'
        && !requestOnly(entry, this.store.usageLevel())
        && (oldGroup ? entry.group !== oldGroup : true)));
    const routeTask = { ...task, preferredProfileId: '', requirePreferred: false, thinkingOptionId: '',
      profileRequests: { ...task.profileRequests, worker: undefined } };
    const select = (candidates: Profile[]) => chooseProfile(routeTask, candidates, pool, this.store.counts(), unavailable, 'worker',
      this.store.recentCounts(), this.store.usageLevel(), this.store.demandRoleOffsets(), false);
    return select(eligible.filter(candidate => !old || candidate.provider !== old.provider))
      ?? select(eligible);
  }

  /**
   * Resume a stopped retained provider thread in place. The attempt intent and
   * stable message id are durable before delivery, so an uncertain send parks
   * for attention instead of being replayed as a duplicate turn.
   */
  async resumeTransientProviderThread(task: Task, run: Run, state: Awaited<ReturnType<Adapter['observe']>>): Promise<boolean> {
    if (this.paused() || dispatchBlocked(this.store.task(task.id))) return true;
    if (reviewAuthorizationRequired(this.store.task(task.id), this.store)) return true;
    if (run.completion) return false;
    if (run.role === 'revision' && task.failoverReason) return false;
    const retry = run.transientProviderRetry?.runId === run.id ? run.transientProviderRetry : null;
    const stillCurrent = () => {
      const current = this.store.task(task.id), latest = this.store.run(run.id);
      if (!latest || latest.released || latest.agentId !== run.agentId || latest.head !== run.head) return false;
      if (isDispositionActive(current) || isDispositionComplete(current) || dispatchBlocked(current) || reviewAuthorizationRequired(current, this.store)) return false;
      return run.role === 'recovery'
        ? current.resolution.recovery?.runId === run.id && current.coordinatorGeneration === run.generation
        : current.resolution.currentRunId === run.id && (!coordinative(run) || current.coordinatorGeneration === run.generation);
    };
    const save = (next: TransientProviderRetry | null) => {
      const current = this.store.run(run.id);
      if (!current) return;
      this.store.putRun({ ...current, transientProviderRetry: next ?? undefined });
    };
    const markProgress = (current: TransientProviderRetry) => {
      if (current.sawProgress) return current;
      const next = { ...current, sawProgress: true, observedUpdatedAt: state.updatedAt ?? current.observedUpdatedAt };
      save(next);
      return next;
    };
    const decision = transientResumeDecision(active(state), state.status, retry?.status, false);
    if (decision === 'busy') {
      if (retry?.status === 'waiting') {
        save(null);
        this.store.event(task.id, 'transient_provider_retry_cancelled', `${run.id}: retained thread resumed before its scheduled continuation`);
      } else if (retry?.status === 'intent') {
        const next = { ...retry, status: 'sent' as const, retryAt: null, resumedAt: now(), observedUpdatedAt: state.updatedAt ?? null, sawProgress: true };
        save(next);
        this.store.event(task.id, 'transient_provider_resume_reconciled', `${run.id}: thread is active after an interrupted delivery intent`);
      } else if (retry?.status === 'sent') markProgress(retry);
      this.clearResumedProviderWait(task.id);
      return false;
    }
    if (decision === 'settled') {
      if (retry?.status === 'waiting') save(null);
      if (retry?.status === 'intent' || retry?.status === 'uncertain') {
        const evidence = retry.error || state.error || 'provider delivery outcome is unknown';
        const reason = `Transient provider continuation delivery is uncertain for ${run.role} run ${run.id}; inspect the retained thread. Evidence: ${evidence}`;
        save({ ...retry, status: 'uncertain', retryAt: null, error: evidence.slice(0, 2000) });
        this.attention(this.store.task(task.id), reason);
        return true;
      }
      if (retry?.status === 'sent' && state.status === 'idle' && !state.error) {
        const resumedAt = Date.parse(retry.resumedAt ?? now());
        if (Date.now() - resumedAt >= this.graceMs) {
          this.attention(this.store.task(task.id), `The ${run.role} thread stopped after its transient provider continuation without a result; inspect the retained thread. Evidence: ${retry.error}`);
          return true;
        }
        this.waiting(this.store.task(task.id), `Waiting for the ${run.role} thread to report after its transient provider continuation`, 'lifecycle');
        return true;
      }
      return false;
    }
    if (!stillCurrent()) return true;
    if (decision === 'uncertain' && retry) {
      const evidence = retry.error || state.error;
      save({ ...retry, status: 'uncertain', retryAt: null, error: evidence.slice(0, 2000) });
      this.attention(this.store.task(task.id), `Transient provider continuation delivery is uncertain for ${run.role} run ${run.id}; inspect the retained thread. Evidence: ${evidence}`);
      return true;
    }
    if (decision === 'exhausted') {
      if (isRateLimitError(state.error) && run.role === 'revision') {
        const current = this.store.task(task.id);
        const failover = this.selectRateLimitFailover(current);
        if (failover) {
          const reason = `Transient rate limit persisted after ${TRANSIENT_MAX_RESUMES} same-thread resumes for ${run.role} run ${run.id}; routing to another eligible profile at the same capability (${failover.profile.provider}/${failover.profile.model}). Evidence: ${state.error}`.slice(0, 2000);
          this.store.update(current.id, { failoverReason: reason, replacementProfile: { profileId: failover.profile.id, reason: `Rate-limit failover at the same capability: ${state.error.slice(0, 300)}` } }, 'rate_limit_failover_armed', reason);
          this.store.event(current.id, 'rate_limit_failover_armed', `${run.role} ${run.id}: ${failover.profile.id}; ${state.error.slice(0, 1200)}`);
          return false;
        }
        const cause = digest(`rate_limit_no_alternative:${current.id}:${run.id}`);
        const reason = `Transient rate limit persisted after ${TRANSIENT_MAX_RESUMES} same-thread resumes for ${run.role} run ${run.id} and no alternate profile exists at the same capability. Evidence: ${state.error}`;
        this.attention(current, reason);
        if (!plannerEscalations(this.store.eventsAll(current.id) as LadderEvent[]).some(escalation => escalation.cause === cause))
          this.openPlannerEscalation(current, { cause, runId: run.id, question: `${reason} Decide how the retained worker should proceed.`, payload: { cause, runId: run.id, reason } });
        else this.waiting(this.store.task(current.id), escalationWaitDetail.planner(plannerEscalations(this.store.eventsAll(current.id) as LadderEvent[]).find(escalation => escalation.cause === cause)!.id), 'escalated');
        return true;
      }
      this.attention(this.store.task(task.id), `Transient provider error persisted after ${TRANSIENT_MAX_RESUMES} same-thread resumes for ${run.role} run ${run.id}; no failover was attempted. Evidence: ${state.error}`);
      return true;
    }
    if (decision === 'sent' && retry) {
      if (transientSentDecision(isTransientProviderError(state.error), false, retry.resumes) === 'failed') {
        const reason = `agent_errored: retained ${run.role} thread returned to error after its same-thread continuation: ${state.error.slice(0, 400)}`;
        save({ ...retry, status: 'exhausted', retryAt: null, error: reason.slice(0, 2000) });
        this.store.update(task.id, { failoverReason: reason }, 'worker_resume_failed', reason);
        this.store.event(task.id, 'worker_resume_failed', `Continuation for ${run.role} run ${run.id} was sent but the retained thread returned to error without an active turn`);
        return false;
      }
      const changed = retry.error !== state.error || Boolean(state.updatedAt && retry.observedUpdatedAt && state.updatedAt !== retry.observedUpdatedAt);
      const nextBackoff = steppedDelay(TRANSIENT_BACKOFF_MS, retry.resumes);
      const oldErrorStillVisible = !retry.sawProgress && !changed && Date.now() - Date.parse(retry.resumedAt ?? now()) < nextBackoff;
      if (transientSentDecision(true, oldErrorStillVisible, retry.resumes) === 'wait') {
        this.waiting(this.store.task(task.id), `Transient provider error was resumed in the same ${run.role} thread; waiting before another check. Evidence: ${state.error}`, 'provider_unavailable');
        return true;
      }
      if (transientSentDecision(true, false, retry.resumes) === 'exhausted') {
        const exhausted = { ...retry, status: 'exhausted' as const, retryAt: null, error: state.error.slice(0, 2000), observedUpdatedAt: state.updatedAt ?? retry.observedUpdatedAt };
        save(exhausted);
        if (isRateLimitError(state.error) && run.role === 'revision') {
          const current = this.store.task(task.id);
          const failover = this.selectRateLimitFailover(current);
          if (failover) {
            const reason = `Transient rate limit persisted after ${TRANSIENT_MAX_RESUMES} same-thread resumes for ${run.role} run ${run.id}; routing to another eligible profile at the same capability (${failover.profile.provider}/${failover.profile.model}). Evidence: ${state.error}`.slice(0, 2000);
            this.store.update(current.id, { failoverReason: reason, replacementProfile: { profileId: failover.profile.id, reason: `Rate-limit failover at the same capability: ${state.error.slice(0, 300)}` } }, 'rate_limit_failover_armed', reason);
            this.store.event(current.id, 'rate_limit_failover_armed', `${run.role} ${run.id}: ${failover.profile.id}; ${state.error.slice(0, 1200)}`);
            return false;
          }
          const cause = digest(`rate_limit_no_alternative:${current.id}:${run.id}`);
          const reason = `Transient rate limit persisted after ${TRANSIENT_MAX_RESUMES} same-thread resumes for ${run.role} run ${run.id} and no alternate profile exists at the same capability. Evidence: ${state.error}`;
          this.attention(current, reason);
          if (!plannerEscalations(this.store.eventsAll(current.id) as LadderEvent[]).some(escalation => escalation.cause === cause))
            this.openPlannerEscalation(current, { cause, runId: run.id, question: `${reason} Decide how the retained worker should proceed.`, payload: { cause, runId: run.id, reason } });
          else this.waiting(this.store.task(current.id), escalationWaitDetail.planner(plannerEscalations(this.store.eventsAll(current.id) as LadderEvent[]).find(escalation => escalation.cause === cause)!.id), 'escalated');
          return true;
        }
        const reason = `Transient provider error persisted after ${TRANSIENT_MAX_RESUMES} same-thread resumes for ${run.role} run ${run.id}; no failover was attempted. Evidence: ${state.error}`;
        this.attention(this.store.task(task.id), reason);
        return true;
      }
    }
    let pending = retry;
    if (!pending || pending.status !== 'waiting') {
      const resumes = pending?.resumes ?? 0;
      pending = {
        runId: run.id, resumes, status: 'waiting', error: state.error.slice(0, 2000),
        retryAt: transientProviderRetryAt(state.error, resumes), messageId: null,
        resumedAt: null, observedUpdatedAt: state.updatedAt ?? null, sawProgress: false,
      };
      save(pending);
      this.recordRateLimitCooldown(run.profileGroup ?? this.store.pool().find(entry => run.profile && entry.profileId === run.profile.id)?.group, state.error);
      this.store.event(task.id, 'transient_provider_retry_scheduled', `${run.role} ${run.id}: resume ${Math.min(resumes + 1, TRANSIENT_MAX_RESUMES)}/${TRANSIENT_MAX_RESUMES} at ${pending.retryAt}; ${state.error.slice(0, 1200)}`);
    }
    if (transientWaitingDecision(Date.now() < Date.parse(pending.retryAt!), pending.resumes, true) === 'wait') {
      const seconds = Math.max(1, Math.ceil((Date.parse(pending.retryAt!) - Date.now()) / 1000));
      this.waiting(this.store.task(task.id), `Transient provider error; resuming the same ${run.role} thread in ${seconds}s. Evidence: ${state.error}`, 'provider_unavailable');
      return true;
    }
    if (transientWaitingDecision(false, pending.resumes, true) === 'exhausted') {
      const exhausted = { ...pending, status: 'exhausted' as const, retryAt: null };
      save(exhausted);
      if (isRateLimitError(state.error) && run.role === 'revision') {
        const current = this.store.task(task.id);
        const failover = this.selectRateLimitFailover(current);
        if (failover) {
          const reason = `Transient rate limit persisted after ${TRANSIENT_MAX_RESUMES} same-thread resumes for ${run.role} run ${run.id}; routing to another eligible profile at the same capability (${failover.profile.provider}/${failover.profile.model}). Evidence: ${state.error}`.slice(0, 2000);
          this.store.update(current.id, { failoverReason: reason, replacementProfile: { profileId: failover.profile.id, reason: `Rate-limit failover at the same capability: ${state.error.slice(0, 300)}` } }, 'rate_limit_failover_armed', reason);
          this.store.event(current.id, 'rate_limit_failover_armed', `${run.role} ${run.id}: ${failover.profile.id}; ${state.error.slice(0, 1200)}`);
          return false;
        }
        const cause = digest(`rate_limit_no_alternative:${current.id}:${run.id}`);
        const reason = `Transient rate limit persisted after ${TRANSIENT_MAX_RESUMES} same-thread resumes for ${run.role} run ${run.id} and no alternate profile exists at the same capability. Evidence: ${state.error}`;
        this.attention(current, reason);
        if (!plannerEscalations(this.store.eventsAll(current.id) as LadderEvent[]).some(escalation => escalation.cause === cause))
          this.openPlannerEscalation(current, { cause, runId: run.id, question: `${reason} Decide how the retained worker should proceed.`, payload: { cause, runId: run.id, reason } });
        else this.waiting(this.store.task(current.id), escalationWaitDetail.planner(plannerEscalations(this.store.eventsAll(current.id) as LadderEvent[]).find(escalation => escalation.cause === cause)!.id), 'escalated');
        return true;
      }
      this.attention(this.store.task(task.id), `Transient provider error persisted after ${TRANSIENT_MAX_RESUMES} same-thread resumes for ${run.role} run ${run.id}; no failover was attempted. Evidence: ${state.error}`);
      return true;
    }
    if (transientWaitingDecision(false, pending.resumes, Boolean(this.adapter.continueRun)) === 'no_channel') {
      const reason = `agent_errored: no delivery channel exists for the retained ${run.role} continuation`;
      save({ ...pending, status: 'exhausted', retryAt: null });
      this.store.update(task.id, { failoverReason: reason }, 'worker_resume_failed', reason);
      return false;
    }
    const attempt = pending.resumes + 1;
    const messageId = `ns-resume-${run.id}-${attempt}`;
    const intent: TransientProviderRetry = { ...pending, resumes: attempt, status: 'intent', retryAt: null, messageId, error: state.error.slice(0, 2000) };
    save(intent);
    this.store.event(task.id, 'transient_provider_resume_intent', `${run.role} ${run.id}: attempt ${attempt}/${TRANSIENT_MAX_RESUMES} at exact head ${run.head}`);
    const prompt = `Nucleus transient provider continuation for task ${task.id}, run ${run.id}, exact head ${run.head}. Continue where you left off; report via your existing authenticated callback for this same run. Do not start a new run or change the requested head.`;
    try {
      if (!stillCurrent()) throw new Error('Retained run changed before the continuation was sent');
      await this.resolution.onTaskHost(run, () => this.adapter.continueRun!(run, messageId, prompt));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof ProvenPreSendRefusalError) {
        const reason = `agent_errored: same-thread continuation was refused before send: ${detail}`.slice(0, 2000);
        save({ ...intent, status: 'exhausted', retryAt: null, error: reason });
        this.store.update(task.id, { failoverReason: reason }, 'worker_resume_refused', reason);
        return false;
      }
      save({ ...intent, status: 'uncertain', error: `${state.error}; continuation delivery: ${detail}`.slice(0, 2000) });
      this.attention(this.store.task(task.id), `Transient provider continuation for ${run.role} run ${run.id} has uncertain delivery; inspect the retained thread before retrying. Evidence: ${state.error}; delivery: ${detail}`);
      return true;
    }
    let postSend: Awaited<ReturnType<Adapter['observe']>> | null = null;
    try { postSend = await this.resolution.onTaskHost(run, () => this.resolution.host.observe(run.agentId!)); } catch { /* the accepted message is recorded; a later observation decides progress */ }
    if (postSend?.status === 'error' && !active(postSend) && !postSend.permissions) {
      const reason = `agent_errored: retained ${run.role} thread returned to error immediately after same-thread continuation: ${(postSend.error || state.error || 'no error detail').slice(0, 400)}`;
      const failed = { ...intent, status: 'exhausted' as const, retryAt: null, error: reason.slice(0, 2000), resumedAt: now(), observedUpdatedAt: postSend.updatedAt ?? null, sawProgress: false };
      const latestRun = this.store.run(run.id);
      if (latestRun) this.store.putRun({ ...latestRun, transientProviderRetry: failed });
      this.store.update(task.id, { failoverReason: reason }, 'worker_resume_failed', reason);
      return false;
    }
    const latest = this.store.run(run.id);
    const sent: TransientProviderRetry = {
      ...intent, status: 'sent', resumedAt: now(),
      observedUpdatedAt: postSend?.updatedAt ?? state.updatedAt ?? null,
      sawProgress: postSend ? active(postSend) || !isTransientProviderError(postSend.error) : false,
    };
    if (latest) this.store.putRun({ ...latest, transientProviderRetry: sent, active: postSend ? active(postSend) : null, idleSince: postSend && active(postSend) ? null : now() });
    this.store.event(task.id, 'transient_provider_resumed', `${run.role} ${run.id}: attempt ${attempt}/${TRANSIENT_MAX_RESUMES} resumed at exact head ${run.head}; ${state.error.slice(0, 1200)}`);
    this.waiting(this.store.task(task.id), `Transient provider error resumed in the same ${run.role} thread; awaiting its authenticated result`, 'provider_unavailable');
    return true;
  }

  /** Initial worker runs live on Task rather than in the resolution-run table. */
  async resumeTransientWorker(task: Task, state: Awaited<ReturnType<Adapter['observe']>>): Promise<boolean> {
    const runId = task.runId;
    const retry = task.transientProviderRetry?.runId === runId ? task.transientProviderRetry : null;
    // A closed RPC process cannot accept a continuation. A merely scheduled
    // retry has sent nothing; an intent or uncertain delivery must still be
    // reconciled by the existing delivery rules.
    if (state.status === 'error' && !state.active && !state.activeTurnId && !state.permissions
      && /\bRPC process is closed\b/i.test(state.error) && (!retry || retry.status === 'waiting')) return false;
    // A deliberate author continuation owns a new authenticated revision ticket.
    // Never revive the initial ticket after a worker restart moved the task to changes_requested.
    const stillInitial = () => {
      const current = this.store.task(task.id);
      return current.runId === runId && current.agentId === task.agentId &&
        ['working', 'dispatching', 'needs_attention'].includes(current.phase) &&
        !current.completion && !current.resolution.currentRunId &&
        !current.resolution.prePrResumeInstruction && !current.failoverReason;
    };
    if (!runId || !task.agentId || !task.workspaceId || !stillInitial()) return false;
    const save = (next: TransientProviderRetry | null) => {
      if (!stillInitial()) return;
      this.store.update(task.id, { transientProviderRetry: next ?? undefined });
    };
    const initialDecision = transientResumeDecision(Boolean(state.active || state.activeTurnId || state.permissions || ['running', 'initializing'].includes(state.status)), state.status, retry?.status, false);
    if (initialDecision === 'busy') {
      if (retry?.status === 'waiting') save(null);
      else if (retry?.status === 'intent') {
        save({ ...retry, status: 'sent', retryAt: null, resumedAt: now(), observedUpdatedAt: state.updatedAt ?? null, sawProgress: true });
        this.store.event(task.id, 'transient_provider_resume_reconciled', `worker ${runId}: thread is active after an interrupted delivery intent`);
      }
      else if (retry?.status === 'sent' && !retry.sawProgress) save({ ...retry, sawProgress: true, observedUpdatedAt: state.updatedAt ?? retry.observedUpdatedAt });
      this.clearResumedProviderWait(task.id);
      return false;
    }
    if (initialDecision === 'settled') {
      if (retry?.status === 'waiting' && (!state.error || state.status !== 'error')) save(null);
      if (retry?.status === 'intent' || retry?.status === 'uncertain') {
        const evidence = retry.error || state.error || 'provider delivery outcome is unknown';
        this.attention(this.store.task(task.id), `Transient provider continuation delivery is uncertain for worker run ${runId}; inspect the retained thread. Evidence: ${evidence}`);
        save({ ...retry, status: 'uncertain', retryAt: null, error: evidence.slice(0, 2000) });
        return true;
      }
      // Spec 051: an interactive worker that resumed and went idle is back in its
      // operator session, not missing a result; reconcile shows the session wait.
      if (retry?.status === 'sent' && state.status === 'idle' && !state.error && interactiveSessionOpen(this.store.task(task.id), this.store.runs(task.id))) {
        save(null);
        return false;
      }
      if (retry?.status === 'sent' && state.status === 'idle' && !state.error && retry.resumedAt && Date.now() - Date.parse(retry.resumedAt) >= this.graceMs) {
        this.attention(this.store.task(task.id), `The worker thread stopped after its transient provider continuation without a result; inspect the retained thread. Evidence: ${retry.error}`);
        return true;
      }
      if (retry?.status === 'sent' && state.status === 'idle' && !state.error) {
        this.waiting(this.store.task(task.id), 'Waiting for the worker thread to report after its transient provider continuation', 'lifecycle');
        return true;
      }
      return false;
    }
    const decision = transientResumeDecision(false, state.status, retry?.status, isQuotaExhaustion(state.error));
    if (decision === 'quota') return false;
    const current = this.store.task(task.id);
    if (decision === 'uncertain' && retry) {
      this.attention(current, `Transient provider continuation delivery is uncertain for worker run ${runId}; inspect the retained thread. Evidence: ${state.error}`);
      save({ ...retry, status: 'uncertain', retryAt: null, error: state.error.slice(0, 2000) });
      return true;
    }
    if (decision === 'exhausted' && retry) {
      if (isRateLimitError(state.error)) {
        const failover = this.selectRateLimitFailover(current);
        if (failover) {
          const reason = `Transient rate limit persisted after ${TRANSIENT_MAX_RESUMES} same-thread resumes for worker run ${runId}; routing to another eligible profile at the same capability (${failover.profile.provider}/${failover.profile.model}). Evidence: ${state.error}`.slice(0, 2000);
          save({ ...retry, status: 'exhausted', retryAt: null, error: state.error.slice(0, 2000) });
          this.store.update(current.id, { failoverReason: reason, replacementProfile: { profileId: failover.profile.id, reason: `Rate-limit failover at the same capability: ${state.error.slice(0, 300)}` } }, 'rate_limit_failover_armed', reason);
          this.store.event(current.id, 'rate_limit_failover_armed', `worker ${runId}: ${failover.profile.id}; ${state.error.slice(0, 1200)}`);
          return false;
        }
        const cause = digest(`rate_limit_no_alternative:${current.id}:${runId}`);
        const reason = `Transient rate limit persisted after ${TRANSIENT_MAX_RESUMES} same-thread resumes for worker run ${runId} and no alternate profile exists at the same capability. Evidence: ${state.error}`;
        this.attention(current, reason);
        if (!plannerEscalations(this.store.eventsAll(current.id) as LadderEvent[]).some(escalation => escalation.cause === cause))
          this.openPlannerEscalation(current, { cause, runId, question: `${reason} Decide how the retained worker should proceed.`, payload: { cause, runId, reason } });
        else this.waiting(this.store.task(current.id), escalationWaitDetail.planner(plannerEscalations(this.store.eventsAll(current.id) as LadderEvent[]).find(escalation => escalation.cause === cause)!.id), 'escalated');
        return true;
      }
      this.attention(current, `Transient provider error persisted after ${TRANSIENT_MAX_RESUMES} same-thread resumes for worker run ${runId}; no failover was attempted. Evidence: ${state.error}`);
      return true;
    }
    if (decision === 'sent' && retry) {
      if (transientSentDecision(isTransientProviderError(state.error), false, retry.resumes) === 'failed') {
        const reason = `agent_errored: retained worker returned to error after its same-thread continuation: ${state.error.slice(0, 400)}`;
        save({ ...retry, status: 'exhausted', retryAt: null, error: reason.slice(0, 2000) });
        this.store.update(task.id, { failoverReason: reason }, 'worker_resume_failed', reason);
        this.store.event(task.id, 'worker_resume_failed', `Continuation for worker run ${runId} was sent but the retained thread returned to error without an active turn`);
        return false;
      }
      const changed = retry.error !== state.error || Boolean(state.updatedAt && retry.observedUpdatedAt && state.updatedAt !== retry.observedUpdatedAt);
      const nextBackoff = steppedDelay(TRANSIENT_BACKOFF_MS, retry.resumes);
      if (transientSentDecision(true, !retry.sawProgress && !changed && Date.now() - Date.parse(retry.resumedAt ?? now()) < nextBackoff, retry.resumes) === 'wait') {
        this.waiting(current, `Transient provider error was resumed in the same worker thread; waiting before another check. Evidence: ${state.error}`, 'provider_unavailable');
        return true;
      }
      if (transientSentDecision(true, false, retry.resumes) === 'exhausted') {
        save({ ...retry, status: 'exhausted', retryAt: null, error: state.error.slice(0, 2000), observedUpdatedAt: state.updatedAt ?? retry.observedUpdatedAt });
        if (isRateLimitError(state.error)) {
          const failover = this.selectRateLimitFailover(current);
          if (failover) {
            const reason = `Transient rate limit persisted after ${TRANSIENT_MAX_RESUMES} same-thread resumes for worker run ${runId}; routing to another eligible profile at the same capability (${failover.profile.provider}/${failover.profile.model}). Evidence: ${state.error}`.slice(0, 2000);
            this.store.update(current.id, { failoverReason: reason, replacementProfile: { profileId: failover.profile.id, reason: `Rate-limit failover at the same capability: ${state.error.slice(0, 300)}` } }, 'rate_limit_failover_armed', reason);
            this.store.event(current.id, 'rate_limit_failover_armed', `worker ${runId}: ${failover.profile.id}; ${state.error.slice(0, 1200)}`);
            return false;
          }
          const cause = digest(`rate_limit_no_alternative:${current.id}:${runId}`);
          const reason = `Transient rate limit persisted after ${TRANSIENT_MAX_RESUMES} same-thread resumes for worker run ${runId} and no alternate profile exists at the same capability. Evidence: ${state.error}`;
          this.attention(current, reason);
          if (!plannerEscalations(this.store.eventsAll(current.id) as LadderEvent[]).some(escalation => escalation.cause === cause))
            this.openPlannerEscalation(current, { cause, runId, question: `${reason} Decide how the retained worker should proceed.`, payload: { cause, runId, reason } });
          else this.waiting(this.store.task(current.id), escalationWaitDetail.planner(plannerEscalations(this.store.eventsAll(current.id) as LadderEvent[]).find(escalation => escalation.cause === cause)!.id), 'escalated');
          return true;
        }
        this.attention(current, `Transient provider error persisted after ${TRANSIENT_MAX_RESUMES} same-thread resumes for worker run ${runId}; no failover was attempted. Evidence: ${state.error}`);
        return true;
      }
    }
    let pending = retry;
    if (!pending || pending.status !== 'waiting') {
      const resumes = pending?.resumes ?? 0;
      pending = { runId, resumes, status: 'waiting', error: state.error.slice(0, 2000), retryAt: transientProviderRetryAt(state.error, resumes), messageId: null, resumedAt: null, observedUpdatedAt: state.updatedAt ?? null, sawProgress: false };
      save(pending);
      this.recordRateLimitCooldown(current.profileGroup ?? this.store.pool().find(entry => current.profile && entry.profileId === current.profile.id)?.group, state.error);
      this.store.event(task.id, 'transient_provider_retry_scheduled', `worker ${runId}: resume ${Math.min(resumes + 1, TRANSIENT_MAX_RESUMES)}/${TRANSIENT_MAX_RESUMES} at ${pending.retryAt}; ${state.error.slice(0, 1200)}`);
    }
    if (transientWaitingDecision(Date.now() < Date.parse(pending.retryAt!), pending.resumes, true) === 'wait') {
      const seconds = Math.max(1, Math.ceil((Date.parse(pending.retryAt!) - Date.now()) / 1000));
      this.waiting(current, `Transient provider error; resuming the same worker thread in ${seconds}s. Evidence: ${state.error}`, 'provider_unavailable');
      return true;
    }
    if (transientWaitingDecision(false, pending.resumes, true) === 'exhausted') {
      save({ ...pending, status: 'exhausted', retryAt: null });
      if (isRateLimitError(state.error)) {
        const latest = this.store.task(task.id);
        const failover = this.selectRateLimitFailover(latest);
        if (failover) {
          const reason = `Transient rate limit persisted after ${TRANSIENT_MAX_RESUMES} same-thread resumes for worker run ${runId}; routing to another eligible profile at the same capability (${failover.profile.provider}/${failover.profile.model}). Evidence: ${state.error}`.slice(0, 2000);
          this.store.update(latest.id, { failoverReason: reason, replacementProfile: { profileId: failover.profile.id, reason: `Rate-limit failover at the same capability: ${state.error.slice(0, 300)}` } }, 'rate_limit_failover_armed', reason);
          this.store.event(latest.id, 'rate_limit_failover_armed', `worker ${runId}: ${failover.profile.id}; ${state.error.slice(0, 1200)}`);
          return false;
        }
        const cause = digest(`rate_limit_no_alternative:${latest.id}:${runId}`);
        const reason = `Transient rate limit persisted after ${TRANSIENT_MAX_RESUMES} same-thread resumes for worker run ${runId} and no alternate profile exists at the same capability. Evidence: ${state.error}`;
        this.attention(latest, reason);
        if (!plannerEscalations(this.store.eventsAll(latest.id) as LadderEvent[]).some(escalation => escalation.cause === cause))
          this.openPlannerEscalation(latest, { cause, runId, question: `${reason} Decide how the retained worker should proceed.`, payload: { cause, runId, reason } });
        else this.waiting(this.store.task(latest.id), escalationWaitDetail.planner(plannerEscalations(this.store.eventsAll(latest.id) as LadderEvent[]).find(escalation => escalation.cause === cause)!.id), 'escalated');
        return true;
      }
      this.attention(current, `Transient provider error persisted after ${TRANSIENT_MAX_RESUMES} same-thread resumes for worker run ${runId}; no failover was attempted. Evidence: ${state.error}`);
      return true;
    }
    if (transientWaitingDecision(false, pending.resumes, Boolean(this.adapter.continueWorker)) === 'no_channel') {
      const reason = 'agent_errored: no delivery channel exists for the retained worker continuation';
      save({ ...pending, status: 'exhausted', retryAt: null });
      this.store.update(task.id, { failoverReason: reason }, 'worker_resume_failed', reason);
      return false;
    }
    const attempt = pending.resumes + 1, intentId = `provider-${runId}-${attempt}`;
    const intent: TransientProviderRetry = { ...pending, resumes: attempt, status: 'intent', retryAt: null, messageId: intentId, error: state.error.slice(0, 2000) };
    save(intent);
    this.store.event(task.id, 'transient_provider_resume_intent', `worker ${runId}: attempt ${attempt}/${TRANSIENT_MAX_RESUMES}`);
    const prompt = `Nucleus transient provider continuation for task ${task.id}, worker run ${runId}, planning head ${task.planningBase}. Continue where you left off; report via your existing authenticated callback for this same run. Do not start a new run or change the requested head or task branch.`;
    try {
      if (!stillInitial()) return false;
      await this.resolution.onTaskHost(task, () => this.adapter.continueWorker!(task, intentId, prompt));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof ProvenPreSendRefusalError) {
        const reason = `agent_errored: same-thread continuation was refused before send: ${detail}`.slice(0, 2000);
        if (stillInitial()) {
          this.store.update(task.id, { failoverReason: reason }, 'worker_resume_refused', reason);
          this.store.event(task.id, 'worker_resume_failed', `Continuation for worker run ${runId} was refused before send; replacement may proceed: ${detail.slice(0, 1200)}`);
        }
        return false;
      }
      save({ ...intent, status: 'uncertain', error: `${state.error}; continuation delivery: ${detail}`.slice(0, 2000) });
      if (!stillInitial()) return false;
      this.attention(this.store.task(task.id), `Transient provider continuation for worker run ${runId} has uncertain delivery; inspect the retained thread before retrying. Evidence: ${state.error}; delivery: ${detail}`);
      return true;
    }
    let postSend: Awaited<ReturnType<Adapter['observe']>> | null = null;
    try { postSend = await this.resolution.onTaskHost(task, () => this.resolution.host.observe(task.agentId!)); } catch { /* use the pre-send observation as a conservative baseline */ }
    if (postSend?.status === 'error' && !active(postSend) && !postSend.permissions) {
      const reason = `agent_errored: retained worker returned to error immediately after same-thread continuation: ${(postSend.error || state.error || 'no error detail').slice(0, 400)}`;
      save({ ...intent, status: 'exhausted', retryAt: null, error: reason.slice(0, 2000), resumedAt: now(), observedUpdatedAt: postSend.updatedAt ?? null, sawProgress: false });
      this.store.update(task.id, { failoverReason: reason }, 'worker_resume_failed', reason);
      this.store.event(task.id, 'worker_resume_failed', `Continuation for worker run ${runId} was sent but the retained thread immediately returned to error without an active turn`);
      return false;
    }
    const sent: TransientProviderRetry = { ...intent, status: 'sent', resumedAt: now(), observedUpdatedAt: postSend?.updatedAt ?? state.updatedAt ?? null, sawProgress: postSend ? active(postSend) || !isTransientProviderError(postSend.error) : false };
    save(sent);
    this.store.event(task.id, 'transient_provider_resumed', `worker ${runId}: attempt ${attempt}/${TRANSIENT_MAX_RESUMES} resumed in place; ${state.error.slice(0, 1200)}`);
    if (!stillInitial()) return false;
    this.waiting(this.store.task(task.id), 'Transient provider error resumed in the same worker thread; awaiting its authenticated result', 'provider_unavailable');
    return true;
  }
}
