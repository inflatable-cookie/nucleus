/**
 * The phase transitions out of reviewing: a source-approval proof wait that
 * settles into an evidence-only review, a changes-requested round that launches
 * its revision, and a review skipped at submission that goes straight to the
 * merge prerequisites. Each names the fence that decides it before it writes.
 */
import { awaitingProofTexts, type Task } from '../../shared/contracts';
import { taskPrNumber } from '../forge/index';
import { currentBrief } from '../planning/brief';
import { now, type Store } from '../store/store';
import { operatorReplacementPending } from '../recovery/task-reasons';
import { awaitingProofMatchesSelector, declaredProofSelectors } from '../qa/proof-wait';
import type { Adapter } from '../host/adapter';
import type { TaskStops } from '../recovery/task-stops';
import { slotRequestFenced } from '../dispatch/capacity';
import { blockingRecoveryEffectsRefusal } from '../recovery/recovery-effects';
import { prerequisiteWaitBlocksPhase } from '../store/store-prerequisites';

export interface ReviewAdvancesContext {
  readonly store: Store;
  readonly adapter: Pick<Adapter, 'verifyPrIdentity'>;
  stopped(): boolean;
  update: TaskStops['update'];
  waiting: TaskStops['waiting'];
  slotAdmissionReason(t: Task): string;
  launch(t: Task, role: 'revision'): Promise<void>;
}

export class ReviewAdvances {
  constructor(readonly context: ReviewAdvancesContext) {}

  async settleSourceApprovalProof(t: Task): Promise<Task | null> {
    const sourceApproval = t.resolution.review!;
    // The proof wait is the control state only while the task waits on proof. An owner's
    // return to the author (changes_requested) supersedes it: the approval stays recorded,
    // and the author's new head still invalidates it below once reported.
    const pr = await this.context.adapter.verifyPrIdentity?.(t, taskPrNumber(t));
    const current = this.context.store.task(t.id);
    if (current.version !== t.version || this.context.stopped()) return null;
    if (pr && pr.head !== sourceApproval.head) {
      t = this.context.update(current, { review: null }, { phase: 'changes_requested', reason: 'Head moved; source approval invalidated, returning to the author for authenticated readiness' }, 'source_approval_invalidated');
    } else {
      const approvalRun = this.context.store.run(sourceApproval.runId);
      const declaredSelectors = declaredProofSelectors(current);
      const settled = awaitingProofTexts(sourceApproval.awaitingProofs).every(awaitingProof => current.proofExecutions.some(proof =>
        awaitingProofMatchesSelector(awaitingProof, proof.selector, declaredSelectors)
        && proof.status === 'passed' && proof.head === sourceApproval.head
        && proof.branch === current.branch && proof.prNumber === taskPrNumber(current)
        && proof.briefDigest === (currentBrief(current)?.digest ?? null)
        && Boolean(approvalRun && !approvalRun.proofOnly && proof.settledAt && Date.parse(proof.settledAt) > Date.parse(approvalRun.createdAt))
        && Boolean(proof.runId && this.context.store.run(proof.runId)?.released
          && this.context.store.run(proof.runId)?.completion?.status === 'proof_executed'
          && this.context.store.run(proof.runId)?.completion?.proofResult?.status === 'passed')));
      if (!pr || !settled) {
        this.context.waiting(current, `Source approved at ${sourceApproval.head}; awaiting proof: ${awaitingProofTexts(sourceApproval.awaitingProofs).join(', ')}`, 'awaiting_proof');
        return null;
      }
      t = this.context.update(current, {}, { phase: 'awaiting_review', reason: 'Required proof settled; independent evidence-only review pending' }, 'proof_review_ready');
    }
    return t;
  }

  async advanceChangesRequested(t:Task): Promise<void> {
    if (prerequisiteWaitBlocksPhase(t)) return;
    // Keep the released wait and its instruction discoverable while another
    // owner stop or effect still owns the task. The reservation rechecks both.
    if (t.prerequisiteWait && (slotRequestFenced(t) || blockingRecoveryEffectsRefusal(this.context.store, t))) return;
    // An operator-approved replacement owns the next worker. Resuming the retained thread here
    // raced the replacement live (nucleus#033, 2026-09-27) and prompted the excluded worker.
    if (operatorReplacementPending(t)) return;
    const capacity = this.context.slotAdmissionReason(t);
    if (capacity) { this.context.waiting(t, capacity, 'capacity'); return; }
    await this.context.launch(t, 'revision');
  }

  advanceSkippedReview(t:Task): void {
    const admissionWait = this.context.slotAdmissionReason(t);
    if (admissionWait) { this.context.waiting(t, admissionWait, 'capacity'); return; }
    this.context.store.transaction(() => {
      const sequence = t.resolution.integrationTurn?.sequence ?? this.context.store.nextIntegrationSequence(t.repoPath);
      this.context.update(t, { integrationTurn: t.resolution.integrationTurn ?? { sequence, acceptedAt: now() } }, { phase: 'merging', reason: 'PR review skipped by submission; checking merge prerequisites' }, 'review_skipped');
    });
  }
}
