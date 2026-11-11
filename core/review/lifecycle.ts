import { awaitingProofTexts, isDispositionActive, type Run, type Task } from '../../shared/contracts';
import { assertCanonicalPrSource, evidenceOnlyPr, taskPrNumber, type ReviewerSetting, type VerifiedPr } from '../forge/index';
import { digest, now, type Store } from '../store/store';
import { currentBrief } from '../planning/brief';
import { retainedProgressRun, retainedWorkHeads } from '../dispatch/retained-work';
import { blockingRecoveryEffects, BlockingRecoveryEffectsError } from '../recovery/recovery-effects';
import { operatorReplacementPending, participantToolRunIds } from '../recovery/task-reasons';
import { matchingInactiveParticipant } from '../intake/run-settlement';
import { awaitingProofMatchesSelector, declaredProofSelectors } from '../qa/proof-execution';
import type { Adapter } from '../host/adapter';
import type { HostFacade } from '../host/host-facade';
import type { TaskStops } from '../recovery/task-stops';
import type { OwnedTools } from '../machine/owned-tool';

export type ContinuedPrBinding = { number: number; url: string; head: string; priorHead: string | null; completionEventId: string;
  branch: string; baseBranch: string; repoPath: string; agentId: string | null; workspaceId: string | null;
  progressRunId?: string;
  /** The dispatch funnel's decision snapshot: the task version and runs it verified from. */
  decided?: { version: number; runs: string } };

/** Ports read live by review and revision; construction stays in the resolution shell. */
export interface ReviewLifecycleContext {
  readonly store: Store;
  readonly adapter: Pick<Adapter, 'verifyPr' | 'verifyPrIdentity' | 'verifyResume'>;
  readonly host: Pick<HostFacade, 'observe'>;
  reviewerSetting(t: Task): ReviewerSetting | null;
  continuedPrBinding(t: Task, number: number, pr: VerifiedPr, decided?: ContinuedPrBinding['decided']): ContinuedPrBinding;
  ordinaryReviewRuns(taskId: string): string;
  ownedToolHold: OwnedTools['ownedToolHold'];
  startsNoRuns(): boolean;
  stopped(): boolean;
  update: TaskStops['update'];
  waiting: TaskStops['waiting'];
  slotAdmissionReason(t: Task): string;
  launch(t: Task, role: 'revision'): Promise<void>;
}

export class ReviewLifecycle {
  constructor(readonly context: ReviewLifecycleContext) {}

  reviewerSetting(t: Task): ReviewerSetting | null {
    return this.context.store.canonicalRepository(t.repoPath, t.repository)?.reviewer ?? null;
  }

  reviewRequired(t: Task): boolean {
    return !t.skipPRReview || Boolean(this.context.reviewerSetting(t));
  }

  async verifyContinuedPr(t: Task): Promise<ContinuedPrBinding | null> {
    const number = evidenceOnlyPr(t);
    if (!number) return null;
    const continuation = Boolean(this.context.adapter.verifyPrIdentity && this.context.adapter.verifyResume);
    const pr = continuation ? await this.context.adapter.verifyPrIdentity!(t, number, { allowDraft: true }) : await this.context.adapter.verifyPr(t, number);
    if (continuation) await this.context.adapter.verifyResume!(t);
    return this.context.continuedPrBinding(t, number, pr);
  }

  bindReportedHeadForReview(t: Task, pr: VerifiedPr): boolean {
    if (t.prHead || t.prUrl || t.resumePrNumber || t.reviewEntry?.prNumber) return false;
    let number: number;
    try { number = taskPrNumber(t); } catch { return false; }
    try { assertCanonicalPrSource(pr, number); } catch { return false; }
    type Candidate = { runId: string; completion: NonNullable<Run['completion']> };
    const candidates: Candidate[] = [];
    const taskCompletion = t.completion;
    if (taskCompletion && (taskCompletion.status === 'blocked' || taskCompletion.status === 'ready_for_review')
      && taskCompletion.prNumber === number && taskCompletion.head === pr.head && t.completion?.runId) {
      const runId = t.completion.runId;
      const receipt = this.context.store.db.prepare('SELECT hash FROM receipts WHERE id=? AND task=? AND run=?').get(taskCompletion.eventId, t.id, runId) as { hash?: string } | undefined;
      if (receipt?.hash === digest(JSON.stringify(taskCompletion))) candidates.push({ runId, completion: taskCompletion });
    }
    for (const run of this.context.store.runs(t.id)) {
      if (run.role !== 'revision' || !run.released || run.status !== 'finished' || !run.completion) continue;
      const completion = run.completion;
      if ((completion.status !== 'blocked' && completion.status !== 'ready_for_review') || completion.prNumber !== number || completion.head !== pr.head) continue;
      if (completion.taskId !== t.id || completion.runId !== run.id) continue;
      const receipt = this.context.store.db.prepare('SELECT hash FROM receipts WHERE id=? AND task=? AND run=?').get(completion.eventId, t.id, run.id) as { hash?: string } | undefined;
      if (receipt?.hash === digest(JSON.stringify(completion))) candidates.push({ runId: run.id, completion });
    }
    if (!candidates.length) return false;
    this.context.store.update(t.id, { prUrl: pr.url, prHead: pr.head, resumePrNumber: number }, 'reported_head_bound',
      `PR #${number} at ${pr.head} from the authenticated ${candidates.at(-1)!.completion.status} report ${candidates.at(-1)!.completion.eventId}; identity only`.slice(0, 2000));
    return true;
  }

  continuedPrBinding(t: Task, number: number, pr: VerifiedPr, decided?: ContinuedPrBinding['decided']): ContinuedPrBinding {
    assertCanonicalPrSource(pr, number);
    return { decided, number, url: pr.url, head: pr.head, priorHead: t.prHead, completionEventId: t.completion!.eventId, branch: t.branch,
      baseBranch: t.baseBranch, repoPath: t.repoPath, agentId: t.agentId, workspaceId: t.workspaceId };
  }

  bindContinuedPrInTx(taskId: string, binding: ContinuedPrBinding, via: string): boolean {
    if (!this.context.store.db.isTransaction) throw new Error('A continued PR binds only inside the accepting transaction');
    const latest = this.context.store.task(taskId);
    const progress = binding.progressRunId ? retainedProgressRun(this.context.store,latest) : null;
    if (binding.progressRunId) retainedWorkHeads(this.context.store,latest,this.context.store.runs(taskId));
    if ((binding.progressRunId ? progress?.id !== binding.progressRunId || progress.completion?.eventId !== binding.completionEventId || taskPrNumber(latest) !== binding.number || Boolean(latest.prUrl && latest.prUrl !== binding.url)
      : evidenceOnlyPr(latest) !== binding.number || latest.completion?.eventId !== binding.completionEventId) || latest.prHead !== binding.priorHead
      || latest.repoPath !== binding.repoPath || latest.branch !== binding.branch || latest.baseBranch !== binding.baseBranch
      || latest.agentId !== binding.agentId || latest.workspaceId !== binding.workspaceId || latest.resolution.mergeIntent || latest.resolution.mergedCommit) return false;
    this.context.store.update(taskId, { prUrl: binding.url, resumePrNumber: binding.number, prHead: binding.head }, 'continued_pr_bound',
      (binding.progressRunId ? `${via}: PR #${binding.number} at ${binding.head}, retained progress from ${binding.completionEventId}; identity only`
        : `${via}: PR #${binding.number} at ${binding.head}, known only from the ${latest.completion!.status} report ${binding.completionEventId}`).slice(0, 2000));
    return true;
  }

  ordinaryReviewRuns(taskId: string): string {
    return JSON.stringify(this.context.store.runs(taskId).map(run => run.released
      ? { ...run, lastObservedAt: null, active: null, idleSince: null } : run));
  }

  async ordinaryRoundCustody(t: Task, run: Run, restoring = false): Promise<void> {
    const snapshot = this.context.ordinaryReviewRuns(t.id);
    const prior = this.context.store.run(run.priorRunId!);
    if (!prior?.released || prior.status !== 'finished' || !prior.completion
      || prior.workspaceId !== run.workspaceId || run.workspaceId !== t.workspaceId)
      throw Error('Earlier ordinary review custody is not settled');
    const receipt = this.context.store.db.prepare('SELECT response FROM receipts WHERE id=? AND task=? AND run=?').get(prior.completion.eventId, t.id, prior.id);
    if (!receipt || JSON.parse(String(receipt.response)).accepted !== true) throw Error('Earlier reviewer callback receipt is missing');
    if (this.context.store.runs(t.id).some(other => other.id !== run.id && !other.released))
      throw Error('Another run owns the ordinary review checkout');
    const blockingEffects = blockingRecoveryEffects(this.context.store, t, { noticeKinds: 'all' });
    if (blockingEffects.length) throw new BlockingRecoveryEffectsError(blockingEffects);
    const taskParticipants = new Set([t.agentId, run.agentId, ...t.retiredWorkers.map(worker => worker.agentId)].filter((id): id is string => Boolean(id)));
    const participants = new Map([...taskParticipants].map(id => [id, t.workspaceId!]));
    if (prior.agentId) participants.set(prior.agentId, t.workspaceId!);
    for (const [id, workspaceId] of participants) {
      const participantRunIds=participantToolRunIds(t,this.context.store.runs(t.id),id,workspaceId);
      const held = await this.context.ownedToolHold(id, { requireCompleteEvidence: true, runId: participantRunIds[0], runIds: participantRunIds, taskId: t.id, workspaceId });
      if (held) throw Error(`Ordinary review participant has live or unknown tools: ${held}`);
      const state = await this.context.host.observe(id);
      // matchingInactiveParticipant admits an errored agent with no active
      // turn and no pending permission wherever it admits a closed one, so a
      // dead provider session never blocks a round that does not need it.
      // The round's own reviewer still needs a live idle agent to receive it.
      if (!matchingInactiveParticipant({ agentId: id, workspaceId }, state, restoring || id !== run.agentId ? ['idle', 'closed'] : ['idle']))
        throw Error('Ordinary review participant is not idle and permission-free in the recorded workspace');
    }
    const latest = this.context.store.task(t.id);
    const reviewIdentity = (task: Task) => JSON.stringify([
      task.resolution.currentRunId === run.id || restoring && run.released && !task.resolution.currentRunId ? run.id : task.resolution.currentRunId,
      task.prHead, task.prUrl, task.workspaceId, task.phase,
      task.resolution.reviewerAgentId, task.resolution.reviewerProfile,
      taskPrNumber(task), currentBrief(task)?.version ?? null, currentBrief(task)?.digest ?? null,
    ]);
    if (this.context.startsNoRuns() || isDispositionActive(latest)
      || (latest.resolution.currentRunId !== run.id && !(restoring && run.released && !latest.resolution.currentRunId))
      || latest.prHead !== run.head || latest.workspaceId !== t.workspaceId || latest.phase !== t.phase
      || reviewIdentity(latest) !== reviewIdentity(t))
      throw Error(`Ordinary review task reservation changed during custody proof (run ${latest.resolution.currentRunId}/${run.id}, head ${latest.prHead}/${run.head}, phase ${latest.phase}/${t.phase})`);
    if (snapshot !== this.context.ordinaryReviewRuns(t.id)) throw Error('Ordinary review run custody changed during proof');
  }

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
    // A retained prerequisite wait resumes only after explicit owner action;
    // completing the source task must not automatically revise the PR.
    if (t.prerequisiteWait?.releasedAt) return;
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
