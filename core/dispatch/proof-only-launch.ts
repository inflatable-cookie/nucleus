import type { Engine } from '../engine';
import type { Profile, Task } from '../../shared/contracts';
import type { Resolution } from '../resolution';
import { proofSingleFlightRefusal, ProofSingleFlightError } from '../qa/proof-execution';

/** The launch and store facts a proof-only dispatch needs. */
export type ProofOnlyLaunchContext = Pick<Engine, 'note' | 'store'> & {
  readonly resolution: Pick<Resolution, 'launch' | 'proofExecution' | 'select' | 'suppressAutomaticRetry'>;
};

/**
 * One owner-activated proof-only launch. It refuses a spent or live execution
 * before anything is sent, selects the executor or release-GO reviewer route,
 * and stands down when a rival trigger reserved the run between the check and
 * the reservation transaction. A proof-only task is never the worker launcher.
 */
export class ProofOnlyLaunch {
  constructor(readonly context: ProofOnlyLaunchContext) {}
  private get store() { return this.context.store; }
  private get resolution() { return this.context.resolution; }
  async launch(task: Task, selectedProfile?: Profile): Promise<void> {
    if (task.entrypoint !== 'proof' || !task.proofOnly) throw new Error('Proof-only launch requires an immutable merged commit');
    const priorProofRun = this.store.runs(task.id).find(run => run.role === 'executor' || run.role === 'reviewer');
    if (priorProofRun && this.resolution.suppressAutomaticRetry(task, 'proof_reactivation',
      `Prior proof run ${priorProofRun.id} at ${priorProofRun.head} ended ${priorProofRun.completion?.status ?? priorProofRun.status}; ${priorProofRun.completion?.summary ?? 'no completion was recorded'}`,
      priorProofRun.id)) return;
    // Task 560: single-flight. The reservation transaction owns the launch,
    // so a rival intent that landed first owns the task: this trigger returns
    // quietly and the restart path and the advance loop never mint a second
    // executor for the same task and head.
    if (proofSingleFlightRefusal(task, this.store.runs(task.id), task.proofOnly.commit)) return;
    const selection = selectedProfile ? { profile: selectedProfile } : this.resolution.select(task, task.requiresOperatorGo ? 'reviewer' : 'executor');
    if (!selection) {
      this.context.note(task.id, `No eligible ${task.requiresOperatorGo ? 'independent reviewer' : 'proof executor'} profile; check the profile pool`, 'route_unavailable');
      return;
    }
    try {
      if (task.requiresOperatorGo) await this.resolution.launch(task, 'reviewer', { profile: selection.profile });
      else await this.resolution.proofExecution(task, {
        authorizedBy: { role: 'queue_dispatch', caller: null, note: 'Proof-only task promoted with a brief-named qualification' }, operationId: null,
      }, selection.profile);
    } catch (error) {
      // A concurrent trigger won the reservation between the check above and
      // the transaction: its intent owns the task, so this trigger stands down.
      if (error instanceof ProofSingleFlightError) return;
      throw error;
    }
  }
}
