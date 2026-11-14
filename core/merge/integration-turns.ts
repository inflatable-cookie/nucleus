import { AsyncLocalStorage } from "node:async_hooks";
import { recoveryEffects, isBlockingRecoveryEffect, recoveryEffectsRefusal } from '../recovery/recovery-effects';
import { mergeFenced, type Task } from '../../shared/contracts';
import { now } from '../store/store';
import { mergeFenceReason } from '../recovery/task-reasons';
import { CAPACITY_WAIT_PREFIX } from '../../shared/wait-state';
import type { Resolution } from '../resolution';

export type IntegrationTurnsContext = Pick<Resolution, 'assignIntegrationTurn' | 'hasEarlierIntegrationTurn' | 'holdLastBlocker' | 'holdsIntegrationTurn' | 'integrationActive' | 'paused' | 'refreshingCloseoutHook' | 'requiredCheckPollState' | 'slotAdmissionReason' | 'store' | 'update' | 'waiting'>;

/** Each repository's FIFO integration turn and the quantum that holds it while its work runs. */
export class IntegrationTurns {
  constructor(readonly resolution: IntegrationTurnsContext) {}
  get store() { return this.resolution.store; }

  // A claimed quantum owns integration until its awaited work has returned. A
  // hook intent created by that work is not a reason for another task to race it.
  private readonly integrationQuanta = new Set<string>();
  private readonly integrationScope = new AsyncLocalStorage<boolean>();
  async integrationQuantum<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    return this.integrationScope.run(true, async () => {
      try { return await work(); }
      finally { this.integrationQuanta.delete(taskId); }
    });
  }
  private integrationBlock(t: Task): string | null {
    if (['done', 'cancelled', 'blocked', 'error', 'needs_attention'].includes(t.phase)) return t.reason;
    if (this.resolution.paused()) return 'Nucleus is paused';
    if (mergeFenced(t)) return mergeFenceReason(t);
    if (t.resolution.attention || t.resolution.recovery?.status === 'escalated' ||
        ['escalated', 'responsible_question', 'budget', 'paused_stop'].includes(t.resolution.stop?.reason ?? '')) return t.reason;
    // Use the same durable effects as executionLease. Active merge work is
    // protected by its quantum; stranded intents yield without losing sequence.
    const refresh = this.resolution.refreshingCloseoutHook(t, t.phase === 'syncing');
    const ownedCloseout = new Set(this.store.hookEvents(t.id).filter(record =>
      t.phase === 'closing' && record.event === 'task.closeout' && record.state === 'blocked').map(record => record.id));
    const effects = recoveryEffects(this.store, t, { kinds: ['operation', 'hook', 'run-delivery', 'review-delivery', 'publication', 'attention-notice'] })
      .filter(effect => isBlockingRecoveryEffect(effect) && !(effect.kind === 'hook' &&
        (effect.identity === refresh?.id || ownedCloseout.has(effect.identity))));
    return recoveryEffectsRefusal(effects);
  }
  integrationActive(t: Task) {
    if (!t.resolution.integrationTurn) return false;
    // Unknown delivery is not proof of non-merge, even after escalation.
    if (t.resolution.mergeIntent && !t.resolution.mergedCommit) return true;
    if (this.integrationQuanta.has(t.id)) return this.quantumOwesTurn(t);
    if (this.integrationBlock(t)) return false;
    // The durable poll record is what makes this a check wait; the reason text is only its wording.
    if (this.resolution.requiredCheckPollState(t)) return false;
    return ['verifying', 'merging', 'syncing', 'closing'].includes(t.phase);
  }
  /**
   * Queue #705: a task that wrote `closed_out` at a synchronized merge owes the
   * repository nothing more. What its quantum still holds is thread and workspace
   * cleanup, which must not keep the next task's integration turn.
   */
  private quantumOwesTurn(t: Task): boolean {
    return !(t.phase === 'done' && Boolean(t.resolution.mergedCommit) && Boolean(t.resolution.syncedCommit));
  }
  /** A quantum id that still names a retained task; removed rows used to be excluded by `tasks()`. */
  private retainedQuantumTask(id: string): Task | null {
    const task = this.store.taskOrNull(id);
    return task && task.removedAt == null ? task : null;
  }
  hasEarlierIntegrationTurn(t: Task) {
    const quantum = [...this.integrationQuanta].map(id => this.retainedQuantumTask(id)).filter((item): item is Task => item != null);
    if (quantum.some(item => item.id === t.id)) return false;
    if (quantum.some(item => item.id !== t.id && item.repoPath === t.repoPath && this.quantumOwesTurn(item))) return true;
    const turnTasks = this.store.integrationTasks(t.repoPath);
    if (turnTasks.some(other => other.id !== t.id && other.resolution.mergeIntent && !other.resolution.mergedCommit)) return true;
    if (t.resolution.mergeIntent && !t.resolution.mergedCommit) return false;
    const reservation = this.closeoutTurnReservation(t.repoPath);
    if (reservation && reservation.taskId !== t.id) return true;
    const sequence = t.resolution.integrationTurn?.sequence;
    return turnTasks.some(x => x.id !== t.id && this.resolution.integrationActive(x) &&
      (sequence == null || x.resolution.integrationTurn!.sequence < sequence) &&
      !(t.resolution.mergedCommit && (reservation
        ? reservation.bypassedTaskIds.includes(x.id) && this.idleOrdinaryVerification(x)
        : this.parkedVerificationForCloseout(x))));
  }
  private closeoutTurnReservation(repoPath: string) {
    const reservation = this.store.getMeta<{ taskId: string; bypassedTaskIds: string[] }>(`closeoutTurn:${repoPath}`);
    if (!reservation) return null;
    const owner = this.store.taskOrNull(reservation.taskId);
    return owner?.repoPath === repoPath && owner.removedAt == null && owner.resolution.mergedCommit && this.resolution.integrationActive(owner) ? reservation : null;
  }
  private idleOrdinaryVerification(t: Task) {
    return t.phase === 'verifying' && !t.resolution.currentRunId &&
      !t.resolution.mergeIntent && !t.resolution.mergedCommit && !t.resolution.recoveryActive &&
      !t.resolution.projectValidation && !this.store.runs(t.id).some(run => !run.released);
  }
  private parkedVerificationForCloseout(t: Task) {
    // An already-landed merge must release its occupied slot through closeout.
    // A verification waiting for that slot cannot also fence its synchronization.
    return this.idleOrdinaryVerification(t) && (t.reason.startsWith('Waiting for repository integration turn') ||
      t.reason.startsWith(CAPACITY_WAIT_PREFIX) && Boolean(this.resolution.slotAdmissionReason(t)));
  }
  holdsIntegrationTurn(t: Task) {
    return this.resolution.integrationActive(t) && !this.resolution.hasEarlierIntegrationTurn(t);
  }
  assignIntegrationTurn(t: Task) {
    if (t.resolution.integrationTurn) return t;
    const apply = () => {
      const sequence = this.store.nextIntegrationSequence(t.repoPath);
      return this.resolution.update(t, { integrationTurn: { sequence, acceptedAt: now() } }, {}, 'integration_turn_assigned');
    };
    return this.store.db.isTransaction ? apply() : this.store.transaction(apply);
  }
  claimIntegrationTurn(t: Task) {
    const sharedOwner=this.store.tasks().find(candidate=>candidate.id!==t.id&&candidate.repoPath===t.repoPath&&candidate.reviewEntry?.workspaceMode==='shared_canonical'&&
      (!['done','cancelled'].includes(candidate.phase)||candidate.resolution.sharedWorkspace?.branch!=='source'||Boolean(candidate.resolution.sharedWorkspace?.intent)));
    if(sharedOwner){this.resolution.waiting(this.store.task(t.id),`Waiting for shared review-entry checkout ${sharedOwner.id} to release repository integration`, 'lifecycle');return false;}
    // An operator hold keeps an unmerged task out of the integration turn, whatever
    // kind placed it: a stop places a dispatch hold, and a stopped task does not
    // merge (Queue #531). A merge already requested is reconciled, never unwound.
    const fenced = this.store.task(t.id);
    if (mergeFenced(fenced) && !t.resolution.mergeIntent && !t.resolution.mergedCommit) {
      this.resolution.holdLastBlocker(fenced);
      this.resolution.waiting(fenced, mergeFenceReason(fenced), 'held'); return false;
    }
    if (!t.resolution.integrationTurn) t = this.resolution.assignIntegrationTurn(t);
    if (!this.resolution.integrationActive(this.store.task(t.id))) {
      const block = this.integrationBlock(this.store.task(t.id));
      if (block && !t.resolution.attention && !['escalated', 'responsible_question', 'budget', 'paused_stop'].includes(t.resolution.stop?.reason ?? ''))
        this.resolution.waiting(this.store.task(t.id), block, 'lifecycle');
      return false;
    }
    if (this.resolution.holdsIntegrationTurn(this.store.task(t.id))) {
      if (t.resolution.mergedCommit && !this.closeoutTurnReservation(t.repoPath)) {
        const sequence = t.resolution.integrationTurn!.sequence;
        const bypassedTaskIds = this.store.tasks().filter(candidate => candidate.repoPath === t.repoPath &&
          candidate.resolution.integrationTurn && candidate.resolution.integrationTurn.sequence < sequence &&
          this.resolution.integrationActive(candidate) && this.parkedVerificationForCloseout(candidate)).map(candidate => candidate.id);
        if (bypassedTaskIds.length) this.store.setMeta(`closeoutTurn:${t.repoPath}`, { taskId: t.id, bypassedTaskIds });
      }
      if (this.integrationScope.getStore()) this.integrationQuanta.add(t.id);
      return true;
    }
    // A changed bypassed task may now own a real gate. At this synchronous
    // claim boundary the owner has no integration effect in flight; let FIFO
    // decide instead of leaving both sides fenced by an unusable reservation.
    if (this.closeoutTurnReservation(t.repoPath)?.taskId === t.id)
      this.store.deleteMeta(`closeoutTurn:${t.repoPath}`);
    const holder = this.store.integrationTasks(t.repoPath).find(candidate => this.resolution.holdsIntegrationTurn(candidate))
      ?? [...this.integrationQuanta].map(id => this.retainedQuantumTask(id)).find((candidate): candidate is Task =>
        candidate != null && candidate.repoPath === t.repoPath && this.resolution.holdsIntegrationTurn(candidate));
    this.resolution.waiting(this.store.task(t.id), holder
      ? `Waiting for repository integration turn: ${holder.title} (${holder.id}) holds it — ${holder.reason.startsWith('Waiting for repository integration turn') ? 'integration work pending' : holder.reason}`.slice(0, 2000)
      : 'Waiting for repository integration turn', 'lifecycle');
    return false;
  }
}
