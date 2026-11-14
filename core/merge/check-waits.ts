import type { Run, Task } from '../../shared/contracts';
import { isFailedChecksReason, requiredCheckPollMetaKey, REQUIRED_CHECK_ESCALATION_MS, REQUIRED_CHECK_POLL_INTERVAL_MS } from '../forge/index';
import { plannerEscalations, type LadderEvent, type PlannerEscalation } from '../questions/blocker-ladder';
import type { CheckObservationFields, MergeGateResult, OverdueCheckEvidence, RequiredChecksResult, Resolution } from '../resolution';
import { now } from '../store/store';
import { CheckEvidence } from './check-evidence';
import { checkEpisodeStep, type RequiredCheckPollState } from './check-episode';
import { CheckSettlement } from './check-settlement';

export type CheckWaitsContext = Pick<Resolution, 'adapter' | 'attention' | 'paused' | 'recordIncidentEvent' | 'refusePreMerge' | 'reviewerSetting' | 'settleAttentionEpisode' | 'store' | 'update' | 'waiting'>;

/**
 * The required-check wait: what a gate result holds, the durable episode that
 * holds it, the one recovery look it gets and the escalation that follows. Its
 * evidence reads are settings-bound (`CheckEvidence`), its settlement closes the
 * episode its own record names (`CheckSettlement`), and the wait step is one
 * typed decision (`checkEpisodeStep`).
 */
export class CheckWaits {
  private evidenceOwner: CheckEvidence | null = null;
  /**
   * Built on first use: the resolution assigns its adapter after field
   * initializers run, so an eagerly captured adapter would be undefined.
   */
  private get evidence(): CheckEvidence {
    const resolution = this.resolution;
    return this.evidenceOwner ??= new CheckEvidence({
      get adapter() { return resolution.adapter; },
      reviewerSetting: t => resolution.reviewerSetting(t),
      get store() { return resolution.store; },
    });
  }
  private readonly settlement: CheckSettlement;
  constructor(readonly resolution: CheckWaitsContext) {
    this.settlement = new CheckSettlement({
      recordIncidentEvent: resolution.recordIncidentEvent, settleAttentionEpisode: resolution.settleAttentionEpisode,
      store: resolution.store, update: resolution.update,
      pollState: t => this.requiredCheckPollState(t),
      applyMergeGateWait: (t, gate) => this.applyMergeGateWait(t, gate),
      requiredChecks: t => this.evidence.requiredChecks(t),
      paused: () => this.resolution.paused(),
    });
  }
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  paused() { return this.resolution.paused(); }
  update(...args: Parameters<CheckWaitsContext['update']>) { return this.resolution.update(...args); }
  attention(...args: Parameters<CheckWaitsContext['attention']>) { return this.resolution.attention(...args); }
  waiting(...args: Parameters<CheckWaitsContext['waiting']>) { return this.resolution.waiting(...args); }
  refusePreMerge(...args: Parameters<CheckWaitsContext['refusePreMerge']>) { return this.resolution.refusePreMerge(...args); }
  recordIncidentEvent(...args: Parameters<CheckWaitsContext['recordIncidentEvent']>) { return this.resolution.recordIncidentEvent(...args); }
  settleAttentionEpisode(...args: Parameters<CheckWaitsContext['settleAttentionEpisode']>) { return this.resolution.settleAttentionEpisode(...args); }

  /** Shared merge-gate wait: semantic failures return the same PR to its worker; runnerless jobs get one durable same-head rerun; pending checks yield the integration turn and are re-observed on a durable cadence. */
  async applyMergeGateWait(t: Task, gate: { wait: string; needsRebase?: boolean; checksFailed?: boolean; overdue?: boolean; pendingCheck?: boolean; infrastructure?: boolean; infraRunIds?: string[]; overdueCheck?: OverdueCheckEvidence }): Promise<boolean> {
    if (gate.needsRebase) {
      const current = this.store.task(t.id);
      if (current.version !== t.version) return true;
      this.refusePreMerge(current, gate.wait, `merge conflict: ${gate.wait}`);
      return true;
    }
    if (gate.checksFailed) {
      this.finishRequiredCheckWait(t, `Required check reached a failed terminal state at ${t.prHead ?? 'unknown head'}`);
      const current = this.store.task(t.id);
      this.refusePreMerge(current, gate.wait, `merge gate: ${gate.wait}`);
      return true;
    }
    if (gate.infrastructure) { await this.holdInfrastructureCancellation(t, gate.wait, gate.infraRunIds ?? []); return true; }
    if (gate.pendingCheck || gate.overdue) { this.holdPendingCheck(t, gate.wait, Boolean(gate.overdue), gate.overdueCheck); return true; }
    // Branch rules, review threads and merge state come from GitHub text: classify it.
    if (gate.wait) { this.waiting(t, gate.wait, 'classify'); return true; }
    this.resolvePassedUnchangedCheckEscalation(this.store.task(t.id));
    return false;
  }
  /** A later green gate settles the check-specific planner wait without buying another review. */
  resolvePassedUnchangedCheckEscalation(t: Task): void {
    if (!this.store.eventsAll(t.id).some(event => event.kind === 'unchanged_check_revision_refused')) return;
    const escalation = plannerEscalations(this.store.eventsAll(t.id) as LadderEvent[])
      .findLast(item => {
        const work = item.runId ? this.store.run(item.runId) : null;
        return !item.answered && this.escalationIsFailedCheck(item, work) && work?.role === 'revision'
          && work.revisionCause === 'pre_merge' && work.head === t.prHead;
      });
    if (escalation) {
      this.store.event(t.id, 'planner_escalation_resolved', `${escalation.id}: required check passed at reviewed head ${t.prHead ?? 'unknown'}`);
      if (t.resolution.stop?.reason === 'escalated')
        this.waiting(this.store.task(t.id), 'Required check passed; reacquiring repository integration turn', 'lifecycle');
    }
  }
  /**
   * Which refusal an escalation answers. Every escalation this version opens
   * carries the class on its payload. An escalation opened before that field
   * existed names none, and that in-flight record keeps the previous
   * identification: the revision instruction Queue wrote for the failed check.
   * This is the one bounded compatibility read; a payload with a class never
   * reads the instruction text.
   */
  private escalationIsFailedCheck(escalation: PlannerEscalation, work: Run | null): boolean {
    if (escalation.refusal !== null) return escalation.refusal === 'failed_checks';
    return Boolean(work && isFailedChecksReason(work.instruction));
  }
  requiredCheckPollState(t: Task): RequiredCheckPollState | null {
    if (!t.prHead) return null;
    const state = this.store.getMeta<RequiredCheckPollState>(requiredCheckPollMetaKey(t.id, t.prHead));
    return state?.head === t.prHead && Number.isFinite(state.nextAt) ? state : null;
  }
  holdPendingCheck(t: Task, wait: string, overdue: boolean, overdueCheck?: OverdueCheckEvidence) {
    const head = t.prHead;
    if (!head) { this.attention(t, 'Required check wait has no recorded reviewed PR head'); return; }
    const previous = this.requiredCheckPollState(t);
    // A check that was classified as overdue can briefly come back from a
    // later gate read as the generic "PR checks are pending" (the provider's
    // status/elapsed fields are not stable between reads). Keep its one
    // recovery and escalation budget while that same-head wait is active.
    const sameOverdueCheck = Boolean(previous?.overdueCheck && (!overdueCheck || previous.overdueCheck.key === overdueCheck.key));
    const retainedOverdueCheck = overdueCheck ?? (sameOverdueCheck ? previous?.overdueCheck : undefined);
    const firstOverdueAt = overdue
      ? (sameOverdueCheck ? previous?.firstOverdueAt : Date.now())
      : (sameOverdueCheck ? previous?.firstOverdueAt : undefined);
    const recoveryRunId = sameOverdueCheck ? previous?.recoveryRunId ?? null : null;
    const attentionRaisedAt = sameOverdueCheck ? previous?.attentionRaisedAt ?? null : null;
    this.store.transaction(() => {
      const current = this.store.task(t.id);
      let incidentId = sameOverdueCheck ? previous?.incidentId ?? null : null;
      const recoveryRun = recoveryRunId ? this.store.run(recoveryRunId) : null;
      const step = checkEpisodeStep({
        overdue, attention: current.resolution.attention, incidentId, recoveryRunId,
        recoveryFinished: Boolean(recoveryRunId && recoveryRun?.released),
        checkStillQueued: overdueCheck?.state === 'QUEUED' || overdueCheck?.state === 'queued',
        waitedMs: firstOverdueAt === undefined ? 0 : Date.now() - firstOverdueAt,
        attentionRaisedAt,
      });
      if (step === 'escalate') {
        this.raiseCheckAttention(current, wait, incidentId);
        incidentId = this.store.task(t.id).resolution.incident?.id ?? incidentId;
      } else if (step === 'park') this.parkCheckRecovery(current, wait);
      else if (step === 'attention') {
        this.attention(current, wait);
        incidentId = this.store.task(t.id).resolution.incident?.id ?? null;
      } else if (step === 'wait') this.waiting(current, wait, 'lifecycle');
      const latest = this.store.task(t.id);
      this.store.setMeta(requiredCheckPollMetaKey(t.id, head), {
        head, incidentId, nextAt: Date.now() + REQUIRED_CHECK_POLL_INTERVAL_MS,
        ...(retainedOverdueCheck ? {overdueCheck: retainedOverdueCheck, firstOverdueAt, recoveryRunId, attentionRaisedAt: attentionRaisedAt ?? (recoveryRunId && firstOverdueAt !== undefined && Date.now() - firstOverdueAt >= REQUIRED_CHECK_ESCALATION_MS && (retainedOverdueCheck.state === 'QUEUED' || retainedOverdueCheck.state === 'queued') ? Date.now() : null)} : {}),
      });
      if (latest.resolution.integrationTurn && !(latest.resolution.mergeIntent && !latest.resolution.mergedCommit))
        this.update(latest, {}, { reason: wait }, 'integration_turn_yielded_for_check', wait);
    });
  }
  /** Re-open the same check incident after its one recovery look, without recording a repeat incident. */
  private raiseCheckAttention(t: Task, wait: string, incidentId: string | null) {
    const current = this.store.task(t.id);
    const incident = incidentId && current.resolution.incident?.id === incidentId ? current.resolution.incident : null;
    if (incident) {
      const escalated = { ...incident, status: 'escalated' as const, detail: wait.slice(0, 2000), updatedAt: now() };
      this.update(current, { attention: true, incident: escalated }, { reason: wait }, 'needs_attention', wait);
      this.recordIncidentEvent(t.id, escalated);
      return;
    }
    this.update(current, { attention: true }, { reason: wait }, 'needs_attention', wait);
  }
  /** Leave the failed check visible while closing the one recovery episode that could not start it. */
  private parkCheckRecovery(t: Task, wait: string) {
    const current = this.store.task(t.id);
    if (current.resolution.attention) {
      this.update(current, { attention: false }, { reason: wait }, 'check_recovery_parked', wait);
      this.settleAttentionEpisode(t.id, `External required check remains pending: ${wait}`.slice(0, 2000));
    }
    this.waiting(this.store.task(t.id), wait, 'lifecycle');
  }
  captureRequiredCheckIncident(t: Task) {
    const state = this.requiredCheckPollState(t), current = this.store.task(t.id);
    if (state && !state.incidentId && current.resolution.attention && current.resolution.incident)
      this.store.setMeta(requiredCheckPollMetaKey(t.id, state.head), { ...state, incidentId: current.resolution.incident.id });
  }
  /** Runnerless required checks are infrastructure, never semantic findings. The first
   * observation at a head records durable intent and dispatches one same-head rerun. A repeat
   * escalates through attention, while bounded polling continues without holding the FIFO turn. */
  async holdInfrastructureCancellation(t: Task, wait: string, runIds: string[]) {
    const current = this.store.task(t.id);
    const head = current.prHead ?? '';
    if (head) this.holdPendingCheck(current, wait, false);
    const key = `checkInfraRetry:${t.id}:${head}`;
    const retry = this.store.getMeta<{ at: string; runs: string[]; status: string }>(key);
    if (!retry) {
      if (this.paused()) { this.waiting(current, wait, 'lifecycle'); return; }
      this.store.setMeta(key, { at: now(), runs: runIds, status: 'intent' });
      if (this.adapter.rerunFailedWorkflowRuns && runIds.length) {
        try {
          const reran = await this.adapter.rerunFailedWorkflowRuns(current, runIds);
          if (this.paused()) return;
          this.store.setMeta(key, { at: now(), runs: reran, status: 'reran' });
          this.store.event(t.id, 'check_infrastructure_rerun', `Dispatched one same-head rerun of failed jobs for workflow runs ${reran.join(', ')} at ${head.slice(0, 12)}; re-observing`.slice(0, 2000));
        } catch (error) {
          if (this.paused()) return;
          const detail = error instanceof Error ? error.message : String(error);
          this.store.event(t.id, 'check_infrastructure_rerun_failed', `Same-head rerun dispatch failed: ${detail}`.slice(0, 2000));
          this.attention(this.store.task(t.id), `Hosted-runner acquisition cancelled required checks and the same-head rerun could not be dispatched: ${detail}`.slice(0, 2000));
          this.captureRequiredCheckIncident(this.store.task(t.id));
          return;
        }
      } else {
        this.store.event(t.id, 'check_infrastructure_retry', `${wait} (same-head re-observation intent recorded for ${head.slice(0, 12)}; no workflow run ids to rerun)`.slice(0, 2000));
      }
      this.waiting(this.store.task(t.id), wait, 'lifecycle');
      return;
    }
    if (current.resolution.attention && current.reason === wait) return;
    if (retry.status !== 'escalated') {
      this.store.setMeta(key, { ...retry, status: 'escalated' });
      this.store.event(t.id, 'check_infrastructure_escalated', `${wait} (repeat runnerless check at the same head after its one bounded rerun; escalating to the coordinator)`.slice(0, 2000));
    }
    this.attention(this.store.task(t.id), wait);
    this.captureRequiredCheckIncident(this.store.task(t.id));
  }

  finishRequiredCheckWait(t: Task, detail: string): void { this.settlement.finishRequiredCheckWait(t, detail); }
  reobservePendingChecks(t: Task): Promise<boolean> { return this.settlement.reobservePendingChecks(t); }
  repositorySettingsRevision(t: Task): number | null { return this.evidence.settingsRevision(t); }
  gateSettingsCurrent(t: Task, gate: MergeGateResult): boolean { return this.evidence.settingsCurrent(t, gate); }
  mergeGateEvidence(t: Task): Promise<MergeGateResult> { return this.evidence.mergeGate(t); }
  requiredChecksEvidence(t: Task): Promise<RequiredChecksResult> { return this.evidence.requiredChecks(t); }
  observationLine(check: Parameters<CheckEvidence['observationLine']>[0]) { return this.evidence.observationLine(check); }
  recordCheckObservation(t: Task, gate: { head?: string } & CheckObservationFields) { this.evidence.recordObservation(t, gate); }
}
