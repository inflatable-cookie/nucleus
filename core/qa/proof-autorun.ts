import { taskControlInputSchema, type Task } from '../../shared/contracts';
import { docsOnlyProofAutorunSkip, proofAutorunWaitingInputs, proofExecutions, runnableDeclaredProof } from './proof-execution';
import type { Resolution } from '../resolution';

/**
 * Spec 058 (task 540): start a brief-named proof at an approved head without a
 * question, or record why this pass waits, skips or refuses.
 */
export class ProofAutorun {
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }

  /**
   * Spec 058 (task 540): a source approval whose awaited proof is the brief's own declared selector runs
   * through the existing `proof` route at the exact approved head, without a question. Returns true when
   * the run was started, so the caller raises nothing for this task in this pass. Once per head.
   */
  async startRunnableProof(task: Task): Promise<boolean> {
    const runnable = runnableDeclaredProof(task, this.store.runs(task.id));
    if (!runnable || !this.resolution.applyOperatorControl) return false;
    const events = this.store.eventsAll(task.id);
    if (events.some(event => event.kind === 'runnable_proof_started' && event.detail.startsWith(`${runnable.head}:`))) return false;
    if (events.some(event => event.kind === 'proof_autorun_skipped' && event.detail.startsWith(`${runnable.head}:`))) return false;
    const inputWait = await proofAutorunWaitingInputs(task, runnable.head);
    if (inputWait) {
      const detail = `${runnable.head}: ${inputWait}`.slice(0, 4000);
      if (!events.some(event => event.kind === 'proof_autorun_waiting_inputs' && event.detail === detail))
        this.store.event(task.id, 'proof_autorun_waiting_inputs', detail);
      return false;
    }
    const skipReason = await docsOnlyProofAutorunSkip(task, runnable.head);
    if (skipReason) {
      const detail = `${runnable.head}: ${skipReason}`.slice(0, 4000);
      const prior = proofExecutions(task).at(-1)!;
      const review = task.resolution.review!;
      const { awaitingProofs: _awaitingProofs, ...reviewWithoutAwaitingProofs } = review;
      if (prior.status === 'failed') {
        const instruction = `The earlier proof at ${prior.head} failed; its receipt remains the current evidence because only documentation changed afterward. Address the recorded failures, then return the PR for the retained reviewer to judge. Receipt: task.detail → proofExecutions for run ${prior.runId}.\n${prior.evidence}`.slice(0, 4000);
        this.resolution.update(task, { currentRunId: null, review: reviewWithoutAwaitingProofs, pendingWorkerInstruction: instruction,
          pendingRevisionCause: 'review' }, { phase: 'changes_requested', reason: `Documentation-only head ${runnable.head}; prior proof ${prior.runId} failed and remains the evidence` },
        'proof_autorun_skipped', detail);
      } else {
        this.resolution.update(task, { currentRunId: null, review: reviewWithoutAwaitingProofs },
          { phase: 'awaiting_review', reason: `Documentation-only head ${runnable.head}; retained proof receipt ${prior.runId} is ready for reviewer judgment` },
          'proof_autorun_skipped', detail);
      }
      return false;
    }
    try {
      await this.resolution.applyOperatorControl(taskControlInputSchema.parse({ taskId: task.id, version: task.version, action: 'proof',
        reason: `Nucleus ran the brief's runnable proof at ${runnable.head} without a question (Spec 058)`,
        caller: 'nucleus', delegated: true,
        note: `Nucleus ran ${runnable.selector} at ${runnable.head}: the brief names it, and Spec 058 runs a runnable proof without a question`.slice(0, 4000) }));
      this.store.event(task.id, 'runnable_proof_started', `${runnable.head}: ${runnable.selector}`.slice(0, 4000));
      return true;
    } catch (error) {
      const detail = `${runnable.head}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000);
      if (!events.some(event => event.kind === 'runnable_proof_refused' && event.detail === detail)) this.store.event(task.id, 'runnable_proof_refused', detail);
      return false;
    }
  }
}
