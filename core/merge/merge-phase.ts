import { isDispositionActive, type Task } from '../../shared/contracts';
import { AUTOMATIC_REPLAY_LIMIT, type HookEventName, type HookRecord } from '../../shared/hooks';
import { isHookHoldReason } from '../hooks/hooks';
import type { Resolution } from '../resolution';

export type MergePhaseContext = Pick<Resolution, 'store' | 'hooks' | 'paused' | 'stopped' | 'graceMs' | 'update' | 'operatorReturn' | 'mergeGateEvidence'> & {
  resolvePassedUnchangedCheckEscalation(t: Task): void;
};

/** Merge/check restoration and the exact automatic hook replay handoff. */
export class MergePhase {
  constructor(readonly context: MergePhaseContext) {}
  private get store() { return this.context.store; }
  private get hooks() { return this.context.hooks; }
  private get graceMs() { return this.context.graceMs; }
  private paused() { return this.context.paused(); }
  private stopped() { return this.context.stopped(); }
  private update(...args: Parameters<MergePhaseContext['update']>) { return this.context.update(...args); }
  private operatorReturn(...args: Parameters<MergePhaseContext['operatorReturn']>) { return this.context.operatorReturn(...args); }
  private mergeGateEvidence(...args: Parameters<MergePhaseContext['mergeGateEvidence']>) { return this.context.mergeGateEvidence(...args); }
  private resolvePassedUnchangedCheckEscalation(t: Task) { return this.context.resolvePassedUnchangedCheckEscalation(t); }

  /** Advance step: a recorded, unmerged merge intent restores the merging phase. */
  restoreRecordedMergePhase(t: Task): Task {
    // A recorded, unmerged merge intent means the task is merging. A pre-merge
    // phase over it is stale (a legacy reconcile reset it on project-a#3618):
    // restore merging so the intent is observed against the PR, never reissued.
    if (t.resolution.mergeIntent && !t.resolution.mergedCommit && ['awaiting_review', 'reviewing', 'verifying'].includes(t.phase)) {
      t = this.update(t, {}, { phase: 'merging', reason: 'Recorded merge intent: reconciling the merge against the PR' }, 'merge_intent_phase_restored', t.phase);
    }
    return t;
  }
  /** Advance gate: an unchanged failed check that already escalated keeps observing its green-gate recovery. */
  unchangedCheckGateApplies(t: Task): boolean {
    return t.phase === 'verifying' && t.resolution.stop?.reason === 'escalated' && this.store.eventsAll(t.id).some(event => event.kind === 'unchanged_check_revision_refused');
  }
  /** Advance step: re-observe an unchanged failed check and resolve its escalation once its gate has passed. */
  async settleUnchangedCheckGate(t: Task): Promise<Task> {
    // An unchanged failed check already has a read-only green-gate recovery.
    // Keep observing it without claiming integration while its escalation waits.
    const gate = await this.mergeGateEvidence(t);
    if (!gate.wait) this.resolvePassedUnchangedCheckEscalation(this.store.task(t.id));
    t = this.store.task(t.id);
    return t;
  }
  /**
   * True while an exact automatic hook replay still owns a held required
   * integration-base occurrence inside its bounded window. Coordinator
   * attention waits for that window so a mechanically provable base race never
   * spends a recovery coordinator.
   */
  automaticHookReplayPending(t: Task): boolean {
    if (!this.hooks || this.paused() || this.stopped()) return false;
    if (isDispositionActive(t) || !isHookHoldReason(t.reason)) return false;
    const held = this.hooks.heldAutomaticReplay(t);
    if (!held || held.ordinal === null) return false;
    // The durable occurrence is the stable clock: repeated observations never
    // restart the window, and a resolved occurrence stops deferring recovery.
    return Date.now() - Date.parse(held.record.updatedAt) < this.graceMs;
  }
  /**
   * Close the attention episode an exact automatic replay resolved. The replay
   * means only that the fresh occurrence was evaluated normally, so the hold it
   * replaced no longer exists and no recovery coordinator is needed for it.
   */
  settleAutomaticReplayHold(t: Task, records: HookRecord[], event: HookEventName): Task {
    const replayed = records.findLast(record => record.event === event && record.replay !== null);
    if (!replayed) return this.store.task(t.id);
    const current = this.store.task(t.id);
    const detail = `Automatic exact-identity replay ${replayed.replay!.ordinal} of ${AUTOMATIC_REPLAY_LIMIT} at ${replayed.baseCommit} resolved the ${event} hold`;
    // A hold recorded as a task note has no attention episode to close; the
    // resolution still belongs in task history.
    if (!current.resolution.attention && !current.resolution.incident) { this.store.event(t.id, 'hook_replay_resolved', detail); return current; }
    return this.operatorReturn(current, { attention: false }, {}, 'hook_replay_resolved', detail);
  }
  /** Advance step: redrive a held hook replay, or keep the attention. Null stops the pass. */
  async replayHeldAttention(t: Task): Promise<Task | null> {
    // A required integration-base occurrence that only an operational base
    // race holds is re-evaluated through its normal emission path before any
    // recovery coordinator is created for it. The hold's attention flag must
    // not block the integration-turn or lease checks while the fresh
    // occurrence is evaluated; a failed proof or a hold re-records it below.
    if (!isHookHoldReason(t.reason) || !await this.hooks?.automaticReplayAttemptDue(t)) return null;
    t = this.update(t, { attention: false }, { reason: t.reason }, 'hook_replay_redrive');
    return t;
  }
}
