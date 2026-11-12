import type { Incident, Run, Task } from '../../shared/contracts';
import { isDispositionActive, pausedStopWaitReason } from '../../shared/contracts';
import { dataHome } from '../../shared/data-home.mjs';
import { wireLabel } from '../../shared/wire-labels';
import { dispatchBlocked } from '../dispatch/capacity';
import { timelineDispatchState } from '../recovery/provider-refusal';
import {
  mcpBindingPathFromHostRecord, mcpBindingPathFromProcessListing, reportBindingReuseDecision,
} from './report-binding';
import type { Resolution } from '../resolution';
import { reviewAuthorizationRequired } from '../review/review-continuation';
import { latestRunCompletion, now } from '../store/store';
import { reminderClock } from '../recovery/task-reasons';

/** One bounded reminder outcome over already-read facts. */
export type ReminderDecision = 'skip' | 'skip_undispatched' | 'extend' | 'escalate' | 'wait_grace' | 'already_sent' | 'no_channel' | 'send' | 'relaunch';

export function reminderDecision(facts: {
  blocked?: boolean;
  reviewAuth?: boolean;
  escalated?: boolean;
  dispatch?: 'delivered' | 'absent' | 'unverified' | null;
  validationAbsent?: boolean;
  reminderAction?: boolean;
  graceExpired?: boolean;
  alreadySent?: boolean;
  hasChannel?: boolean;
  bindingOutside?: boolean;
}): ReminderDecision {
  if (facts.blocked || facts.reviewAuth || facts.escalated) return 'skip';
  if (facts.bindingOutside) return 'relaunch';
  if (facts.dispatch === 'absent') return 'skip_undispatched';
  if (facts.validationAbsent === false) return 'extend';
  if (facts.reminderAction) return facts.graceExpired ? 'escalate' : 'wait_grace';
  if (facts.alreadySent) return 'already_sent';
  if (facts.hasChannel === false) return 'no_channel';
  return 'send';
}

/** One bounded reminder to a run that stopped without a result. */
export type CallbackRemindersContext = Pick<Resolution, 'adapter' | 'attention' | 'ensureIncident' | 'extendCallbackReminder' | 'graceMs' | 'heavyRunAlive' | 'host' | 'onTaskHost' | 'saveIncident' | 'store' | 'validationEvidence' | 'waiting'>;

export class CallbackReminders {
  constructor(readonly resolution: CallbackRemindersContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  get graceMs() { return this.resolution.graceMs; }

  /** One bounded callback reminder for a stopped resolution run; escalation follows only after its grace expires. */
  async remindStoppedRun(t: Task, run: Run) {
    // Queue #650: a paused-stop marker proves the stop was the operator's, never
    // a fault; Queue resumes the thread on unpause instead of reminding.
    if (run.pausedStop) { this.resolution.waiting(this.store.task(t.id), pausedStopWaitReason(run.role), 'paused_stop'); return; }
    if (isDispositionActive(t) || dispatchBlocked(this.store.task(t.id)) || reviewAuthorizationRequired(this.store.task(t.id), this.store) || run.completion) return;
    if (await this.resolution.heavyRunAlive(t)) { this.resolution.extendCallbackReminder(this.store.task(t.id), run.id); return; }
    const incident = this.resolution.ensureIncident(t, run, `The ${run.role} thread stopped without a callback; inspect the thread`, '', 'missing_callback');
    await this.deliverCallbackReminder(this.store.task(t.id), incident, run.agentId!, run.id, run.role, run);
  }
  /** Worker variant: the initial run lives on the task, not the runs table. */
  async remindStoppedWorker(t: Task) {
    // Queue #650: a paused-stop marker proves the stop was the operator's, never
    // a fault; Queue resumes the thread on unpause instead of reminding.
    if (t.pausedStop) { this.resolution.waiting(t, pausedStopWaitReason('worker'), 'paused_stop'); return; }
    if (isDispositionActive(t) || dispatchBlocked(this.store.task(t.id)) || !t.runId || !t.agentId || t.completion || latestRunCompletion(this.store.runs(t.id))) return;
    if (await this.resolution.heavyRunAlive(t)) { this.resolution.extendCallbackReminder(this.store.task(t.id), t.runId); return; }
    const incident = this.resolution.ensureIncident(t, null, 'Worker stopped without a completion callback; inspect the thread');
    await this.deliverCallbackReminder(this.store.task(t.id), incident, t.agentId, t.runId, 'worker', null);
  }
  /**
   * Restart the missing-callback grace while a reminder is already outstanding.
   * The original reminder event stays the one-shot intent; its extension event
   * is the clock so a long QA run cannot expire into coordinator escalation.
   */
  extendCallbackReminder(t: Task, runId: string): void {
    const events = this.store.events(t.id);
    if (!events.some(event => event.kind === 'callback_reminder' && event.detail === runId)) return;
    const clock = reminderClock(events, runId);
    const current = this.store.task(t.id);
    const incident = current.resolution.incident;
    const eventDue = !clock || Date.now() - Date.parse(clock) >= this.graceMs;
    const incidentDue = incident?.runId === runId && incident.action === 'callback_reminder' && incident.status !== 'escalated'
      && Date.now() - Date.parse(incident.updatedAt) >= this.graceMs;
    if (!eventDue && !incidentDue) return;
    const extended = events.find(event => event.kind === 'callback_reminder_extended' && event.detail === runId);
    if (extended) this.store.touchEvent(extended.id);
    else this.store.event(t.id, 'callback_reminder_extended', runId);
    if (incident?.runId === runId && incident.action === 'callback_reminder' && incident.status !== 'escalated') {
      const evidence = this.resolution.validationEvidence(current);
      this.resolution.saveIncident(current, { detail: evidence.state === 'unverified'
        ? 'Callback reminder extended; worktree validation scan is unverified'
        : 'Callback reminder extended; validation is still running in the worktree' });
    }
  }
  private async deliverCallbackReminder(t: Task, incident: Incident, agentId: string, runId: string, role: string, run: Run | null) {
    const blocked = dispatchBlocked(this.store.task(t.id));
    const reviewAuth = reviewAuthorizationRequired(this.store.task(t.id), this.store);
    const escalated = incident.status === 'escalated';
    let dispatch: 'delivered' | 'absent' | 'unverified' | null = null;
    if (!(blocked || reviewAuth || escalated) && role === 'reviewer' && run?.agentId && this.adapter.agentTimelinePage) {
      try { dispatch = timelineDispatchState(await this.resolution.onTaskHost(run, () => this.resolution.host.agentTimelinePage(run.agentId!, 100)), run.id); }
      catch { dispatch = 'unverified'; }
    }
    let validationAbsent: boolean | undefined;
    if (!(blocked || reviewAuth || escalated) && dispatch !== 'absent')
      validationAbsent = this.resolution.validationEvidence(t).state === 'absent';
    let graceExpired: boolean | undefined;
    let alreadySent: boolean | undefined;
    let hasChannel: boolean | undefined;
    let bindingOutside: boolean | undefined;
    if (!(blocked || reviewAuth || escalated) && agentId) {
      try {
        const state = await this.resolution.onTaskHost(run ?? { hostId: t.hostId }, () => this.resolution.host.observe(agentId));
        let bindingPath = state.mcpBindingPath ?? mcpBindingPathFromHostRecord(state);
        const bindingKey = wireLabel(state.labels, 'mcpBinding');
        if (!bindingPath && bindingKey) {
          bindingPath = mcpBindingPathFromProcessListing(
            await this.adapter.hostProcessListing?.() ?? null,
            bindingKey,
          );
        }
        let home: string | undefined;
        try { home = dataHome(); } catch { /* unknown home does not prove the path is outside */ }
        bindingOutside = Boolean(home) && reportBindingReuseDecision({ bindingPath, dataHome: home }) === 'fresh';
      } catch { /* an unreadable observation does not prove the path is outside */ }
    }
    if (!(blocked || reviewAuth || escalated) && dispatch !== 'absent' && validationAbsent) {
      if (incident.action === 'callback_reminder') {
        // The durable reminder event is the clock: repeated detail updates never restart the grace.
        const sentAt = reminderClock(this.store.events(t.id), runId);
        graceExpired = Boolean(sentAt && Date.now() - Date.parse(sentAt) >= this.graceMs);
      } else {
        alreadySent = this.store.events(t.id).some(event => event.kind === 'callback_reminder' && event.detail === runId);
        if (!alreadySent) hasChannel = Boolean(this.adapter.notify);
      }
    }
    switch (reminderDecision({ blocked, reviewAuth, escalated, dispatch, validationAbsent, reminderAction: incident.action === 'callback_reminder', graceExpired, alreadySent, hasChannel, bindingOutside })) {
      case 'skip': return;
      case 'relaunch':
        if (!this.store.events(t.id).some(event => event.kind === 'report_binding_relaunch' && event.detail.includes(runId)))
          this.store.event(t.id, 'report_binding_relaunch', `${role} ${agentId} run ${runId} report binding lives outside the current data home; the callback reminder is skipped and the next restart or dispatch relaunches on a fresh thread`.slice(0, 2000));
        if (!this.store.events(t.id).some(event => event.kind === 'callback_reminder_skipped' && event.detail.startsWith(`${runId}:`)))
          this.store.event(t.id, 'callback_reminder_skipped', `${runId}: report binding lives outside the current data home; the reminder is skipped and the ordinary relaunch applies`.slice(0, 2000));
        return;
      case 'skip_undispatched':
        // A reviewer that never received its dispatch has nothing to re-report:
        // the "submit your existing result" reminder must never fire. Skip it
        // and park for the ordinary relaunch instead of waiting out a grace.
        // Anything less than a provably complete page without the dispatch is
        // unverified, never absence, so an unreadable timeline keeps the
        // existing reminder path.
        if (!this.store.events(t.id).some(event => event.kind === 'callback_reminder_skipped' && event.detail.startsWith(`${runId}:`)))
          this.store.event(t.id, 'callback_reminder_skipped', `${runId}: no dispatch message in the reviewer timeline; the reminder is skipped and the ordinary relaunch applies`.slice(0, 2000));
        this.resolution.attention(this.store.task(t.id), `Reviewer run ${runId} stopped without a delivered dispatch (its timeline carries no dispatch message); the callback reminder is skipped and the run needs its ordinary relaunch`, 'missing_callback');
        return;
      case 'extend':
        this.resolution.extendCallbackReminder(t, runId);
        return;
      case 'escalate':
        this.resolution.attention(t, `The ${role} thread stopped and its one callback reminder expired without a result; coordinator attention required`, 'missing_callback');
        // Hand the fault to coordinator attention: the reminder window is over.
        this.resolution.saveIncident(this.store.task(t.id), { action: '' });
        return;
      case 'wait_grace':
      case 'already_sent':
        return;
      case 'no_channel':
        this.resolution.attention(t, `No delivery channel exists for the ${role} callback reminder; coordinator attention required`);
        return;
      case 'send': {
        const fallbackRun: Run = run ?? { id: runId, taskId: t.id, role: 'revision', generation: t.coordinatorGeneration, head: t.prHead ?? t.planningBase, base: t.planningBase, agentId, workspaceId: t.workspaceId ?? '', profile: null, status: 'running', createdAt: t.createdAt, lastObservedAt: null, active: null, idleSince: null, completion: null, released: false };
        const detail = role === 'revision' ? ' ready_for_review needs the PR number' : role === 'reviewer' ? ' Provide the verdict and full reviewText' : ' Use the original exact-head and generation requirements';
        const message = `Nucleus reporting reminder for ${t.title} (${t.id}). Your ${role} run ${runId} stopped without a result. If the work is complete, report your actual result through the existing authenticated callback for run ${runId}.${detail} Do not restart work, repeat gated actions, or change scope. This is one bounded reporting reminder. ${this.adapter.reportingFallback?.(fallbackRun) ?? ''}`;
        // Persist the one-shot intent before sending; a crash then costs the reminder, never a loop.
        this.resolution.saveIncident(t, { action: 'callback_reminder', status: 'reconciling', detail: 'One bounded callback reminder issued', updatedAt: now() });
        this.store.event(t.id, 'callback_reminder', runId);
        try {
          await this.adapter.notify!(agentId, `ns-reminder-${runId}`, message, t.agentId ?? undefined);
          this.resolution.saveIncident(this.store.task(t.id), { detail: 'One callback reminder sent; awaiting the authenticated result' });
        } catch (error) {
          this.resolution.attention(this.store.task(t.id), `Callback reminder delivery for the ${role} run failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
}
