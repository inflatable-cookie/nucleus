import type { Task } from '../../shared/contracts';
import type { RequiredChecksResult } from '../resolution';
import { requiredCheckPollMetaKey } from '../forge/index';
import { now } from '../store/store';
import type { CheckWaitsContext } from './check-waits';
import type { RequiredCheckPollState } from './check-episode';

/** The wait-owner facts an episode settlement reads and writes through. */
export type CheckSettlementPorts = Pick<CheckWaitsContext, 'recordIncidentEvent' | 'settleAttentionEpisode' | 'store' | 'update'>
  & {
    readonly pollState: (t: Task) => RequiredCheckPollState | null;
    readonly applyMergeGateWait: (t: Task, gate: RequiredChecksResult) => Promise<boolean>;
    readonly requiredChecks: (t: Task) => Promise<RequiredChecksResult>;
    readonly paused: () => boolean;
  };

/**
 * Settling one required-check episode: a green gate or a failed check closes the
 * episode its own durable record names, and a settled poll returns the task to
 * exact-head verification, which reacquires its FIFO turn and repeats every
 * gate. Nothing here derives ownership from the task's reason text.
 */
export class CheckSettlement {
  constructor(readonly ports: CheckSettlementPorts) {}
  private get store() { return this.ports.store; }
  /** Close the check episode the poll record names, and its incident and recovery with it. */
  finishRequiredCheckWait(t: Task, detail: string): void {
    const state = this.ports.pollState(t);
    if (!state) return;
    const head = t.prHead ?? state.head;
    this.store.deleteMeta(requiredCheckPollMetaKey(t.id, head));
    const current = this.store.task(t.id);
    const incident = current.resolution.incident;
    const recovery = current.resolution.recovery;
    const incidentId = state.incidentId ?? this.legacyEpisodeIncident(current);
    const matchesIncident = Boolean(incidentId && incident?.id === incidentId);
    const matchesRecovery = Boolean(incidentId && recovery?.incidentId === incidentId);
    if (!matchesIncident && !matchesRecovery) {
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
      this.ports.update(current, {
        attention: false, incident: nextIncident, recovery: nextRecovery, ...(matchesRecovery ? { recoveryActive: false } : {}),
      }, { reason: detail, ...(supersedeRecovery ? { coordinatorGeneration: current.coordinatorGeneration + 1 } : {}) }, 'required_check_settled', detail);
      if (incident && nextIncident !== incident) this.ports.recordIncidentEvent(t.id, nextIncident!);
      if (hasEpisode) this.ports.settleAttentionEpisode(t.id, detail);
    } else if (current.reason !== detail) {
      this.store.update(t.id, { reason: detail });
    }
  }
  /**
   * A poll record that names no incident (`incidentId: null`, which this version
   * also writes when the wait raised no incident at all) identifies the incident
   * its wait raised the previous way: the task's reason is the pending-check
   * deadline this wait recorded, and the task carries that wait's attention. When
   * no incident was raised the read is inert, because the attention or the
   * incident it needs is absent. A current record therefore consults the reason
   * only when it names no incident, and an unrelated fault's reason never matches
   * this deadline shape, so an unrelated attention is never settled. This is the
   * one bounded compatibility read for in-flight records.
   */
  private legacyEpisodeIncident(t: Task): string | null {
    if (!t.resolution.attention) return null;
    const deadline = t.reason.includes('has been pending past its deadline') && t.reason.includes('job URL:');
    return deadline ? t.resolution.incident?.id ?? null : null;
  }
  /** Re-observe checks without the repository turn. A settled result returns to the ordinary
   * exact-head verification path, which must reacquire its FIFO turn and repeat every gate. */
  async reobservePendingChecks(t: Task): Promise<boolean> {
    if (!['verifying', 'merging'].includes(t.phase)) return false;
    const state = this.ports.pollState(t);
    if (!state) return false;
    if (state.nextAt > Date.now()) return true;
    if (this.ports.paused()) return true;
    t = this.store.task(t.id);
    const gate = await this.ports.requiredChecks(t);
    if (this.ports.paused()) return true;
    if (gate.head !== state.head || gate.head !== this.store.task(t.id).prHead) throw new Error('PR head changed while required checks were pending');
    if (gate.checksFailed || gate.pendingCheck || gate.overdue || gate.infrastructure) {
      await this.ports.applyMergeGateWait(this.store.task(t.id), gate);
      return true;
    }
    this.finishRequiredCheckWait(this.store.task(t.id), `Required checks settled at ${state.head}; reacquiring repository integration turn`);
    return false;
  }
}
