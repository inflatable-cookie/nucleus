/**
 * The task's PR binding and continuation identity. A PR the task knows only from
 * an authenticated report is an identity candidate, never readiness: it binds
 * only when the report's own receipt proves it and the observed PR comes from
 * the canonical repository. Every write here is identity only.
 */
import type { Run, Task } from '../../shared/contracts';
import { assertCanonicalPrSource, evidenceOnlyPr, isCanonicalPrSource, taskHasPr, taskPrNumber, type VerifiedPr } from '../forge/index';
import { digest, type Store } from '../store/store';
import { retainedProgressRun, retainedWorkHeads } from '../dispatch/retained-work';
import type { Adapter } from '../host/adapter';

export type ContinuedPrBinding = { number: number; url: string; head: string; priorHead: string | null; completionEventId: string;
  branch: string; baseBranch: string; repoPath: string; agentId: string | null; workspaceId: string | null;
  progressRunId?: string;
  /** The dispatch funnel's decision snapshot: the task version and runs it verified from. */
  decided?: { version: number; runs: string } };

/** Ports read live by continuation; construction stays in the resolution shell. */
export interface ContinuedPrContext {
  readonly store: Store;
  readonly adapter: Pick<Adapter, 'verifyPr' | 'verifyPrIdentity' | 'verifyResume'>;
  continuedPrBinding(t: Task, number: number, pr: VerifiedPr, decided?: ContinuedPrBinding['decided']): ContinuedPrBinding;
}

export class ContinuedPrs {
  constructor(readonly context: ContinuedPrContext) {}

  async verifyContinuedPr(t: Task): Promise<ContinuedPrBinding | null> {
    const number = evidenceOnlyPr(t);
    if (!number) return null;
    const continuation = Boolean(this.context.adapter.verifyPrIdentity && this.context.adapter.verifyResume);
    const pr = continuation ? await this.context.adapter.verifyPrIdentity!(t, number, { allowDraft: true }) : await this.context.adapter.verifyPr(t, number);
    if (continuation) await this.context.adapter.verifyResume!(t);
    return this.context.continuedPrBinding(t, number, pr);
  }

  /**
   * Bind the head an authenticated worker report names, before review, so the
   * retained reviewer has a head to review. Two separate answers are false: a
   * task that records no PR has nothing to bind, and an observed PR that is not
   * the canonical source is not this task's identity.
   */
  bindReportedHeadForReview(t: Task, pr: VerifiedPr): boolean {
    if (t.prHead || t.prUrl || t.resumePrNumber || t.reviewEntry?.prNumber) return false;
    if (!taskHasPr(t)) return false;
    const number = taskPrNumber(t);
    if (!isCanonicalPrSource(pr, number)) return false;
    type Candidate = { runId: string; completion: NonNullable<Run['completion']> };
    const candidates: Candidate[] = [];
    const taskCompletion = t.completion;
    if (taskCompletion && (taskCompletion.status === 'blocked' || taskCompletion.status === 'ready_for_review')
      && taskCompletion.prNumber === number && taskCompletion.head === pr.head && t.completion?.runId) {
      const runId = t.completion.runId;
      if (this.context.store.receiptHash(taskCompletion.eventId, t.id, runId) === digest(JSON.stringify(taskCompletion)))
        candidates.push({ runId, completion: taskCompletion });
    }
    for (const run of this.context.store.runs(t.id)) {
      if (run.role !== 'revision' || !run.released || run.status !== 'finished' || !run.completion) continue;
      const completion = run.completion;
      if ((completion.status !== 'blocked' && completion.status !== 'ready_for_review') || completion.prNumber !== number || completion.head !== pr.head) continue;
      if (completion.taskId !== t.id || completion.runId !== run.id) continue;
      if (this.context.store.receiptHash(completion.eventId, t.id, run.id) === digest(JSON.stringify(completion)))
        candidates.push({ runId: run.id, completion });
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
}
