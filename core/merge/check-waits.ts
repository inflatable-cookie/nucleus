import type { Task } from '../../shared/contracts';
import { isFailedChecksReason, isPendingCheckDeadlineReason, checkHistoryFromStore, requiredCheckPollMetaKey, REQUIRED_CHECK_POLL_INTERVAL_MS, REQUIRED_CHECK_ESCALATION_MS, checkPolicyObservationKey, type CheckObservation } from '../forge/index';
import { plannerEscalations, type LadderEvent } from '../questions/blocker-ladder';
import type { CheckObservationFields, MergeGateResult, OverdueCheckEvidence, RequiredChecksResult, Resolution } from '../resolution';
import { now } from '../store/store';
import { MERGE_GATE_SETTINGS_ATTEMPTS } from '../recovery/task-reasons';

export type CheckWaitsContext = Pick<Resolution, 'adapter' | 'attention' | 'mergeGateEvidence' | 'paused' | 'recordIncidentEvent' | 'refusePreMerge' | 'reviewerSetting' | 'settleAttentionEpisode' | 'store' | 'update' | 'waiting'>;

type RequiredCheckPollState = {head: string; nextAt: number; incidentId?: string | null; overdueCheck?: OverdueCheckEvidence; firstOverdueAt?: number; recoveryRunId?: string | null; attentionRaisedAt?: number | null};

/** Required-check polling and the freshness-checked gate evidence behind it. */
export class CheckWaits {
  constructor(readonly resolution: CheckWaitsContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  paused() { return this.resolution.paused(); }
  update(...args: Parameters<CheckWaitsContext['update']>) { return this.resolution.update(...args); }
  attention(...args: Parameters<CheckWaitsContext['attention']>) { return this.resolution.attention(...args); }
  waiting(...args: Parameters<CheckWaitsContext['waiting']>) { return this.resolution.waiting(...args); }
  reviewerSetting(...args: Parameters<CheckWaitsContext['reviewerSetting']>) { return this.resolution.reviewerSetting(...args); }
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
        return !item.answered && work?.role === 'revision' && work.revisionCause === 'pre_merge'
          && work.head === t.prHead && isFailedChecksReason(work.instruction);
      });
    if (escalation) {
      this.store.event(t.id, 'planner_escalation_resolved', `${escalation.id}: required check passed at reviewed head ${t.prHead ?? 'unknown'}`);
      if (t.resolution.stop?.reason === 'escalated')
        this.waiting(this.store.task(t.id), 'Required check passed; reacquiring repository integration turn', 'lifecycle');
    }
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
    const sameOverdueCheck = Boolean(overdueCheck && previous?.overdueCheck?.key === overdueCheck.key);
    const firstOverdueAt = overdue ? (sameOverdueCheck ? previous?.firstOverdueAt : Date.now()) : undefined;
    const recoveryRunId = sameOverdueCheck ? previous?.recoveryRunId ?? null : null;
    const attentionRaisedAt = sameOverdueCheck ? previous?.attentionRaisedAt ?? null : null;
    this.store.transaction(() => {
      const current = this.store.task(t.id);
      let incidentId = sameOverdueCheck ? previous?.incidentId ?? null : null;
      if (overdue) {
        const waited = firstOverdueAt === undefined ? 0 : Date.now() - firstOverdueAt;
        const checkStillQueued = overdueCheck?.state === 'QUEUED' || overdueCheck?.state === 'queued';
        const recoveryRun = recoveryRunId ? this.store.run(recoveryRunId) : null;
        const recoveryFinished = Boolean(recoveryRunId && recoveryRun?.released);
        if (recoveryFinished && !checkStillQueued) {
          this.parkCheckRecovery(current, wait);
        } else if (recoveryFinished && waited >= REQUIRED_CHECK_ESCALATION_MS && checkStillQueued && !attentionRaisedAt) {
          this.raiseCheckAttention(current, wait, incidentId);
          incidentId = this.store.task(t.id).resolution.incident?.id ?? incidentId;
        } else if (recoveryFinished && !attentionRaisedAt) {
          this.parkCheckRecovery(current, wait);
        } else if (!recoveryRunId && !current.resolution.attention && !incidentId) {
          this.attention(current, wait);
          incidentId = this.store.task(t.id).resolution.incident?.id ?? null;
        } else if (recoveryFinished && !current.resolution.attention) this.waiting(current, wait, 'lifecycle');
      } else if (!current.resolution.attention) this.waiting(current, wait, 'lifecycle');
      const latest = this.store.task(t.id);
      this.store.setMeta(requiredCheckPollMetaKey(t.id, head), {
        head, incidentId, nextAt: Date.now() + REQUIRED_CHECK_POLL_INTERVAL_MS,
        ...(overdueCheck ? {overdueCheck, firstOverdueAt, recoveryRunId, attentionRaisedAt: attentionRaisedAt ?? (recoveryRunId && firstOverdueAt !== undefined && Date.now() - firstOverdueAt >= REQUIRED_CHECK_ESCALATION_MS && (overdueCheck.state === 'QUEUED' || overdueCheck.state === 'queued') ? Date.now() : null)} : {}),
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
      const escalated = {...incident, status: 'escalated' as const, detail: wait.slice(0, 2000), updatedAt: now()};
      this.update(current, {attention: true, incident: escalated}, {reason: wait}, 'needs_attention', wait);
      this.recordIncidentEvent(t.id, escalated);
      return;
    }
    this.update(current, {attention: true}, {reason: wait}, 'needs_attention', wait);
  }
  /** Leave the failed check visible while closing the one recovery episode that could not start it. */
  private parkCheckRecovery(t: Task, wait: string) {
    const current = this.store.task(t.id);
    if (current.resolution.attention) {
      this.update(current, {attention: false}, {reason: wait}, 'check_recovery_parked', wait);
      this.settleAttentionEpisode(t.id, `External required check remains pending: ${wait}`.slice(0, 2000));
    }
    this.waiting(this.store.task(t.id), wait, 'lifecycle');
  }
  captureRequiredCheckIncident(t: Task) {
    const state = this.requiredCheckPollState(t), current = this.store.task(t.id);
    if (state && !state.incidentId && current.resolution.attention && current.resolution.incident)
      this.store.setMeta(requiredCheckPollMetaKey(t.id, state.head), { ...state, incidentId: current.resolution.incident.id });
  }
  finishRequiredCheckWait(t: Task, detail: string) {
    const head = t.prHead;
    const state = this.requiredCheckPollState(t);
    if (!state && !isPendingCheckDeadlineReason(t.reason)) return;
    if (head) this.store.deleteMeta(requiredCheckPollMetaKey(t.id, head));
    const current = this.store.task(t.id);
    const incident = current.resolution.incident;
    const recovery = current.resolution.recovery;
    const incidentId = state?.incidentId ?? (isPendingCheckDeadlineReason(current.reason) ? incident?.id : null);
    const matchesIncident = Boolean(incidentId && incident?.id === incidentId);
    const matchesRecovery = Boolean(incidentId && recovery?.incidentId === incidentId);
    const ownsEpisode = Boolean(matchesIncident || matchesRecovery)
      || Boolean(isPendingCheckDeadlineReason(current.reason) && current.resolution.attention);
    if (!ownsEpisode) {
      if (!current.resolution.attention && current.reason !== detail) this.store.update(t.id, { reason: detail });
      return;
    }
    const recoveryRun = matchesRecovery && recovery?.runId ? this.store.run(recovery.runId) : null;
    const supersedeRecovery = Boolean(recoveryRun && !recoveryRun.released);
    const nextIncident: typeof current.resolution.incident = incident && incidentId && incident.id === incidentId && incident.status !== 'resolved'
      ? { ...incident, status: 'resolved', detail, updatedAt: now() }
      : incident;
    const nextRecovery: typeof current.resolution.recovery = recovery && incidentId && recovery.incidentId === incidentId && recovery.status !== 'resolved'
      ? { ...recovery, status: 'resolved', summary: detail, idleSince: null, action: null }
      : recovery;
    if (supersedeRecovery) this.store.putRun({ ...recoveryRun!, released: true, status: 'superseded' });
    const hasEpisode = Boolean(current.resolution.attention || matchesIncident && incident!.status !== 'resolved' || matchesRecovery && recovery!.status !== 'resolved');
    if (current.resolution.attention || nextIncident !== incident || nextRecovery !== recovery || matchesRecovery && current.resolution.recoveryActive) {
      this.update(current, {
        attention: false, incident: nextIncident, recovery: nextRecovery, ...(matchesRecovery ? { recoveryActive: false } : {}),
      }, { reason: detail, ...(supersedeRecovery ? { coordinatorGeneration: current.coordinatorGeneration + 1 } : {}) }, 'required_check_settled', detail);
      if (incident && nextIncident !== incident) this.recordIncidentEvent(t.id, nextIncident!);
      if (hasEpisode) this.settleAttentionEpisode(t.id, detail);
    } else if (current.reason !== detail) {
      this.store.update(t.id, { reason: detail });
    }
  }
  /** Re-observe checks without the repository turn. A settled result returns to the ordinary
   * exact-head verification path, which must reacquire its FIFO turn and repeat every gate. */
  async reobservePendingChecks(t: Task): Promise<boolean> {
    if (!['verifying', 'merging'].includes(t.phase)) return false;
    let state = this.requiredCheckPollState(t);
    if (!state && isPendingCheckDeadlineReason(t.reason) && t.prHead) {
      state = { head: t.prHead, incidentId: t.resolution.incident?.id ?? null, nextAt: Date.now() };
      this.store.setMeta(requiredCheckPollMetaKey(t.id, t.prHead), state);
      if (t.resolution.integrationTurn && !(t.resolution.mergeIntent && !t.resolution.mergedCommit)) {
        t = this.update(t, {}, {}, 'integration_turn_yielded_for_check', t.reason);
      }
    }
    if (!state) return false;
    if (state.nextAt > Date.now()) return true;
    if (this.paused()) return true;
    t = this.store.task(t.id);
    const gate = await this.requiredChecksEvidence(t);
    if (this.paused()) return true;
    if (gate.head !== state.head || gate.head !== this.store.task(t.id).prHead) throw new Error('PR head changed while required checks were pending');
    if (gate.checksFailed || gate.pendingCheck || gate.overdue || gate.infrastructure) {
      await this.applyMergeGateWait(this.store.task(t.id), gate);
      return true;
    }
    this.finishRequiredCheckWait(this.store.task(t.id), `Required checks settled at ${state.head}; reacquiring repository integration turn`);
    return false;
  }
  /** Runnerless required checks are infrastructure, never semantic findings. The first
   * observation at a head records durable intent and dispatches one same-head rerun. A repeat
   * escalates through attention, while bounded polling continues without holding the FIFO turn. */
  async holdInfrastructureCancellation(t: Task, wait: string, runIds: string[]) {
    const current = this.store.task(t.id);
    const head = current.prHead ?? '';
    if (head) this.holdPendingCheck(current, wait, false);
    const key = `checkInfraRetry:${t.id}:${head}`;
    const retry = this.store.getMeta<{at: string; runs: string[]; status: string}>(key);
    if (!retry) {
      if (this.paused()) { this.waiting(current, wait, 'lifecycle'); return; }
      this.store.setMeta(key, {at: now(), runs: runIds, status: 'intent'});
      if (this.adapter.rerunFailedWorkflowRuns && runIds.length) {
        try {
          const reran = await this.adapter.rerunFailedWorkflowRuns(current, runIds);
          if (this.paused()) return;
          this.store.setMeta(key, {at: now(), runs: reran, status: 'reran'});
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
  /** The monotonic write revision of the repository settings row a gate reads, so evidence is bound to the settings it was observed under. */
  repositorySettingsRevision(t: Task): number | null {
    return this.store.canonicalRepository(t.repoPath, t.repository)?.revision ?? null;
  }
  /** A gate result is usable only while the settings row it read has not changed; without a revision (test adapters) it is treated as current. */
  gateSettingsCurrent(t: Task, gate: MergeGateResult): boolean {
    return gate.settingsRevision === undefined || gate.settingsRevision === null || gate.settingsRevision === this.repositorySettingsRevision(t);
  }
  /**
   * Always pass store-backed check history; admission snapshots mergeGate before
   * any Engine wrap. A settings write during the observation makes its check
   * policy stale, so the gate is re-observed rather than used: a policy that
   * changed mid-gate never decides a merge. If the row keeps moving, the gate
   * holds visibly instead of merging on evidence from an unknown policy.
   */
  async mergeGateEvidence(t: Task): Promise<MergeGateResult> {
    for (let attempt = 0; attempt < MERGE_GATE_SETTINGS_ATTEMPTS; attempt++) {
      const revision = this.repositorySettingsRevision(t);
      const gate = await this.adapter.mergeGate!(t, checkHistoryFromStore(this.store, t.repoPath, Date.now(), t.prHead ?? ""), this.reviewerSetting(t) ?? undefined, this.store.checksPolicyFor(t));
      const after = this.repositorySettingsRevision(t);
      if (gate.timings) this.store.event(t.id, 'merge_gate_steps', JSON.stringify(gate.timings));
      this.recordCheckObservation(t, {...gate, settingsRevision: revision});
      if (revision === after) return {...gate, settingsRevision: revision};
      this.store.event(t.id, 'merge_gate_settings_changed', `Repository settings changed from revision ${revision} to ${after} while the merge gate observed hosted checks; re-observing before using its result`);
    }
    const current = this.store.task(t.id);
    this.store.event(t.id, 'merge_gate_settings_changed', `Repository settings changed during ${MERGE_GATE_SETTINGS_ATTEMPTS} consecutive merge-gate observations; holding instead of merging on a stale policy`);
    return {head: current.prHead ?? '', base: current.resolution.mergeBase ?? '', wait: 'Repository settings have been changing during the merge gate; re-observing the exact-head gates'};
  }
  /** The same freshness-checked read for the pending-check poll, which yields the integration turn and is re-run before any merge. */
  async requiredChecksEvidence(t: Task): Promise<RequiredChecksResult> {
    for (let attempt = 0; attempt < MERGE_GATE_SETTINGS_ATTEMPTS; attempt++) {
      const revision = this.repositorySettingsRevision(t);
      const gate = this.adapter.requiredChecks
        ? await this.adapter.requiredChecks(t, checkHistoryFromStore(this.store, t.repoPath, Date.now(), t.prHead ?? ""), this.store.checksPolicyFor(t))
        : await this.resolution.mergeGateEvidence(t);
      const after = this.repositorySettingsRevision(t);
      this.recordCheckObservation(t, {...gate, settingsRevision: revision});
      if (revision === after) return {...gate, settingsRevision: revision};
      this.store.event(t.id, 'merge_gate_settings_changed', `Repository settings changed from revision ${revision} to ${after} while required checks were observed; re-observing before acting on the result`);
    }
    return {head: this.store.task(t.id).prHead ?? '', wait: 'Repository settings have been changing during the required-check observation; re-observing the exact-head gates', pendingCheck: true};
  }
  observationLine(check: CheckObservation) {
    return `${check.name} [${check.classification}] ${check.identity}${check.databaseId === null ? '' : `#${check.databaseId}`}${check.appId === null ? '' : ` app ${check.appId}`} ${check.state}${check.conclusion ? `:${check.conclusion}` : ''} (job URL: ${check.jobUrl})`;
  }
  /**
   * Task 382: record the bounded hosted-check observation an advisory policy
   * produced, so both the required results that gated the task and the negative
   * non-required results stay visible in task detail at the exact head. The
   * record names the settings revision whose policy produced it, is
   * deduplicated on the observed facts (never on the observation time) and
   * replaces the previous head's record, so it cannot grow without bound.
   * Recorded evidence never rewrites a check outcome, a prior author return or
   * a review, and proves no targeted test ran.
   */
  recordCheckObservation(t: Task, gate: {head?: string} & CheckObservationFields) {
    if (gate.checksPolicy !== 'required') return;
    const head = gate.head ?? t.prHead ?? '';
    const facts = {
      head,
      policy: 'required' as const,
      settingsRevision: gate.settingsRevision ?? null,
      requirements: gate.requirements ?? null,
      required: (gate.requiredEvidence ?? []).slice(0, 50),
      advisory: (gate.advisory ?? []).slice(0, 50),
    };
    const encoded = JSON.stringify(facts);
    const key = checkPolicyObservationKey(t.id);
    const previous = this.store.getMeta<{digest: string; observedAt: string} & typeof facts>(key);
    if (previous?.digest === encoded) return;
    this.store.setMeta(key, {...facts, digest: encoded, observedAt: now()});
    const requirements = facts.requirements?.known
      ? `${facts.requirements.required} required check(s) for the base branch`
      : `required checks unknown: ${facts.requirements?.reason ?? 'not observed'}`;
    const required = facts.required.map(check => this.observationLine(check)).join(', ');
    const advisory = facts.advisory.map(check => this.observationLine(check)).join(', ');
    const detail = `Checks policy 'required' at ${head.slice(0, 12)} (settings revision ${facts.settingsRevision ?? 'unknown'}): ${requirements}`
      + `; required: ${required || 'none observed'}; advisory: ${advisory || 'none observed'}`;
    this.store.event(t.id, 'check_policy_observation', detail.slice(0, 2000));
  }
}
