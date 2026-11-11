import { resultApplied, recordResultApplied } from '../intake/applied-result';
import type { Completion, Run, Task } from '../../shared/contracts';
import { taskPrNumber } from '../forge/index';
import { git } from '../git/index';
import { hookHoldReason, isCloseoutAuthorityHook, STALE_INTEGRATION_BASE_PROOF, type CloseoutAuthority } from '../hooks/hooks';
import { hostProcessSweepIntent } from '../machine/host-process-reap';
import { isBlockingRecoveryEffect, recoveryEffects, recoveryEffectsRefusal } from '../recovery/recovery-effects';
import type { Resolution } from '../resolution';
import { settlementHeld } from './queue-drain';
import { CLOSEOUT_REFRESH_LIMIT } from '../recovery/task-reasons';

export type CloseoutContext = Pick<Resolution, 'adapter' | 'attention' | 'claimIntegrationTurn' | 'closeoutAuthority' | 'closeoutWritten' | 'executionLease' | 'hookCloseout' | 'hooks' | 'launch' | 'paused' | 'queueCloseout' | 'settleAutomaticReplayHold' | 'stopped' | 'store' | 'turnReleased' | 'update' | 'waiting'>;

/** Select the closeout authority and finish closeout: queue, repository hook or agent. */
export class Closeout {
  constructor(readonly resolution: CloseoutContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  get hooks() { return this.resolution.hooks; }
  private reviewDisclosures(t: Task): string {
    return [
      ...t.resolution.criticalReviewFallbacks.map(record => `Critical review fallback: ${record.reason} (reviewer ${record.reviewerProfileId}).`),
      ...t.resolution.forcedChecks.map(record => `Reviewer forced checks at ${record.head}: ${record.checks.map(check => `${check.name} ${check.jobUrl}`).join(', ')}. ${record.reason}`),
    ].join('\n');
  }
  /** Hand the turn on at the closeout write instead of at quantum end (Queue #705). */
  closeoutWritten(t: Task) {
    const disclosure = this.reviewDisclosures(t);
    if (disclosure && !t.reason.includes(disclosure)) this.store.update(t.id, {reason: `${t.reason}\n${disclosure}`}, 'review_disclosures', disclosure);
    if (t.phase !== 'done' || !t.resolution.mergedCommit || !t.resolution.syncedCommit) return;
    this.resolution.turnReleased?.(t.repoPath);
  }
  /** Select one closeout authority from the manifest pinned at this task's synchronized integration commit. */
  async closeoutAuthority(t: Task): Promise<CloseoutAuthority> {
    const hooks = this.store.hookEvents(t.id);
    if (hooks.some(record => record.event === 'task.closeout' && record.delivery === 'required' && record.mode === 'integration_write')) return 'hook';
    if (this.store.runs(t.id).some(run => run.role === 'closeout')) return 'agent';
    const baseCommit = t.resolution.syncedCommit ?? t.resolution.mergedCommit;
    if (!this.hooks || !baseCommit) return 'agent';
    return this.hooks.closeoutAuthorityAt(t, baseCommit);
  }
  /** Complete closeout in Queue: no run, workspace, hook occurrence, commit or push. */
  async queueCloseout(t: Task): Promise<void> {
    if (!this.resolution.claimIntegrationTurn(t)) return;
    t = this.store.task(t.id);
    if (settlementHeld(this.store, this.resolution.stopped())) return;
    const baseCommit = t.resolution.syncedCommit;
    if (!baseCommit) { this.resolution.attention(t, 'Nucleus-owned closeout requires a synchronized integration commit'); return; }
    this.resolution.update(t, { currentRunId: null, hostProcessSweep: hostProcessSweepIntent('done') }, { phase: 'done', reason: 'Nucleus-owned closeout at the synchronized integration commit' }, 'closed_out');
    this.resolution.closeoutWritten(this.store.task(t.id));
  }
  /**
   * True while a closeout hold may be repaired automatically. A base advance during
   * the integration write is the ordinary case in a busy repository, and an operator
   * retry already knows how to fix it: resync the base and run the hook again. Doing
   * that here removes the wait, and the limit keeps a base that keeps moving parked
   * for a human rather than retried forever.
   */
  private closeoutRefreshAllowed(t: Task, holdReason: string): boolean {
    // Only the stale-integration-base class. A hook's own refusal is a semantic finding
    // and must stay parked for a human, exactly as before.
    if (!holdReason.includes(STALE_INTEGRATION_BASE_PROOF)) return false;
    // Events arrive newest first; count this closeout's refreshes back to its merge.
    const sinceMerge: { kind: string }[] = [];
    for (const event of this.store.events(t.id)) {
      if (event.kind === 'merge_verified') break;
      sinceMerge.push(event);
    }
    return sinceMerge.filter(event => event.kind === 'closeout_hold_refresh').length < CLOSEOUT_REFRESH_LIMIT;
  }
  /** Complete closeout through the repository's authoritative integration-write hook. No closeout run or workspace is created. */
  async hookCloseout(t: Task): Promise<void> {
    if (!this.resolution.claimIntegrationTurn(t)) return;
    t = this.store.task(t.id);
    if (settlementHeld(this.store, this.resolution.stopped())) return;
    const held = this.hooks!.heldAutomaticReplay(t);
    const baseCommit = held?.record.event === 'task.closeout'
      ? await git(t.repoPath, 'rev-parse', 'HEAD')
      : t.resolution.syncedCommit;
    if (!baseCommit) { this.resolution.attention(t, 'Hook-owned closeout requires a synchronized integration commit'); return; }
    const review = t.resolution.review?.summary ?? null;
    const summary = [review ?? 'Hook-owned closeout at the synchronized integration commit', this.reviewDisclosures(t)].filter(Boolean).join('\n');
    const hookState = await this.hooks!.emit('task.closeout', this.store.task(t.id), {
      event: 'task.closeout', baseCommit, summary,
      delivery: { prUrl: t.prUrl, prNumber: taskPrNumber(t), head: t.prHead, review, mergeCommit: t.resolution.mergedCommit, integrationCommit: baseCommit, summary },
    });
    if (hookState.hold) {
      const holdReason = hookHoldReason(hookState);
      // A moved integration base is operational staleness, not a finding: refresh the
      // base and retry, which is exactly what an operator retry does. Bounded, so a
      // repository whose base keeps moving still parks for a human instead of looping.
      if (this.closeoutRefreshAllowed(t, holdReason)) {
        this.resolution.update(this.store.task(t.id), { currentRunId: null, attention: false }, { phase: 'syncing', reason: 'Refreshing main before retrying closeout' }, 'closeout_hold_refresh');
        return;
      }
      this.resolution.attention(this.store.task(t.id), holdReason); return;
    }
    const published = hookState.records.findLast(record => record.state === 'published' && record.mode === 'integration_write' && record.delivery === 'required');
    if (!published) { this.resolution.attention(this.store.task(t.id), 'Hook-owned closeout did not publish a required integration write'); return; }
    const settled = this.resolution.settleAutomaticReplayHold(this.store.task(t.id), hookState.records, 'task.closeout');
    this.resolution.update(settled, { currentRunId: null, syncedCommit: published.commit ?? baseCommit, hostProcessSweep: hostProcessSweepIntent('done') }, { phase: 'done', reason: 'Hook-owned closeout published and synchronized' }, 'closed_out');
    this.resolution.closeoutWritten(this.store.task(t.id));
  }
  async advanceCloseoutResult(t:Task, run:Run, c:Completion): Promise<void> {
    if (resultApplied(this.store, t.id, run.id)) return;
    let closeoutCommit: string | void;
    try { closeoutCommit = await this.adapter.verifyCloseout!(t,c); }
    catch (error) { if (resultApplied(this.store, t.id, run.id)) return; throw error; }
    if (settlementHeld(this.store, this.resolution.stopped()) || run.generation !== this.store.task(t.id).coordinatorGeneration) return;
    const hookState = this.hooks ? await this.hooks.emit('task.closeout', t, { event: 'task.closeout', summary: c.summary, delivery: { prUrl: t.prUrl, prNumber: c.prNumber ?? null, head: t.prHead, review: t.resolution.review?.summary ?? null, mergeCommit: t.resolution.mergedCommit, integrationCommit: closeoutCommit ?? t.resolution.syncedCommit, summary: c.summary } }, hook => !isCloseoutAuthorityHook(hook)) : null;
    if (hookState?.hold) { this.resolution.attention(this.store.task(t.id), hookHoldReason(hookState)); return; }
    if (settlementHeld(this.store, this.resolution.stopped()) || run.generation !== this.store.task(t.id).coordinatorGeneration) return;
    const applied = this.store.transaction(() => {
      const current = this.store.task(t.id);
      if (resultApplied(this.store, t.id, run.id) || current.resolution.currentRunId !== run.id || run.generation !== current.coordinatorGeneration) return false;
      this.resolution.update(current, { currentRunId: null, hostProcessSweep: hostProcessSweepIntent('done'), ...(closeoutCommit?{syncedCommit:closeoutCommit}:{}) }, { phase: 'done', reason: c.summary }, 'closed_out');
      recordResultApplied(this.store, t.id, run.id);
      return true;
    });
    if (applied) this.resolution.closeoutWritten(this.store.task(t.id));
  }
  async advanceClosing(t:Task): Promise<void> {
    // A blocked closeout hook is handled by the closeout authority; uncertain
    // effects and all other task effects must settle independently.
    const closeoutHooks = new Set(this.store.hookEvents(t.id).filter(record => record.event === 'task.closeout' && record.state === 'blocked').map(record => record.id));
    const blocking = recoveryEffects(this.store,t,{kinds:['operation','hook','run-delivery','review-delivery','publication','attention-notice']})
      .filter(effect => isBlockingRecoveryEffect(effect) && !(effect.kind === 'hook' && closeoutHooks.has(effect.identity)));
    if (blocking.length) { this.resolution.waiting(t, `Closeout waits for ${recoveryEffectsRefusal(blocking)}`, 'lifecycle'); return; }
    const authority = await this.resolution.closeoutAuthority(t);
    if (authority === 'hook') await this.resolution.hookCloseout(this.store.task(t.id));
    else if (authority === 'queue') await this.resolution.queueCloseout(this.store.task(t.id));
    else await this.resolution.launch(t, 'closeout');
  }
  async advanceSyncing(t:Task): Promise<void> {
    if (!this.resolution.claimIntegrationTurn(t)) return;
    t = this.store.task(t.id);
    if (!await this.resolution.executionLease(t,undefined,true) || this.resolution.paused()) return;
    const syncStarted = Date.now();
    const commit = await this.adapter.syncMain!(t, () => !this.resolution.paused());
    this.store.event(t.id, 'integration_sync_duration', `${Date.now() - syncStarted}ms`);
    this.resolution.update(t, { syncedCommit: commit }, { phase: 'closing', reason: 'Integration branch synchronized; coordinator closeout pending' }, 'main_synchronized');
  }
}
