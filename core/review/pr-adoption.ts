import { assertCanonicalPrSource, authenticatedWorkerBlock, type VerifiedPr } from '../forge/index';
import type { AgentObservation, Adapter } from '../host/adapter';
import type { HostFacade } from '../host/host-facade';
import type { Store } from '../store/store';
import { retainedProgressRun } from '../dispatch/retained-work';
import { now } from '../store/store';
import { matchingInactiveParticipant } from '../intake/run-settlement';
import type { Run, Task } from '../../shared/contracts';

export interface PrAdoptionContext {
  readonly store: Store;
  readonly adapter: Pick<Adapter, 'verifyPr' | 'findOpenBranchPr' | 'verifyResume'>;
  readonly host: Pick<HostFacade, 'observe'>;
  /** The task-owner host binding every agent-naming call reads (#1154). */
  onTaskHost<T>(owner: { hostId?: string | null } | null | undefined, work: () => T): T;
  paused(): boolean;
  recordBlockedPrIdentity(t: Task, prNumber: number, source: string): Promise<Task>;
}

/**
 * How one PR number reaches an existing task, decided from the task's typed state
 * before anything is observed. A refusal carries its reason, so the caller throws
 * exactly one sentence per shape and no path can fall through to another.
 */
export type PrAdoptionPlan =
  | { kind: 'refuse'; reason: string }
  /** The retained worker's own authenticated block: the PR is identity only. */
  | { kind: 'blocked_identity' }
  | { kind: 'dead_revision'; runs: Run[] }
  | { kind: 'initial_discovery' }
  | { kind: 'replacement'; revision: Run | null; revisionReconcile: boolean };

/** The plan for binding `prNumber` to `t`, from its completion, runs and phase alone. */
export function prAdoptionPlan(t: Task, runs: Run[], prNumber: number): PrAdoptionPlan {
  const acceptedReady = t.completion?.status === 'ready_for_review';
  const noIdentity = !t.prUrl && !t.prHead && !t.resumePrNumber;
  const retainedWorker = Boolean(t.agentId && t.workspaceId && t.directory && t.profile);
  // A revision that died with the PR identity still unbound: the branch PR is
  // discovered under an escalated recovery, and only its exact identity is adopted.
  if (t.phase === 'changes_requested' && t.resolution.attention && t.resolution.recovery?.status === 'escalated'
    && !acceptedReady && noIdentity && retainedWorker && Boolean(t.resolution.currentRunId) && runs.some(run => !run.released))
    return { kind: 'dead_revision', runs };
  // A PR discovered before any run owns it. The worker's own authenticated block
  // keeps the identity-only route (Queue #392): a discovered PR is never readiness.
  if (!acceptedReady && noIdentity && !t.resolution.currentRunId && retainedWorker
    && ['working', 'blocked', 'error', 'needs_attention'].includes(t.phase))
    return authenticatedWorkerBlock(t) ? { kind: 'blocked_identity' } : { kind: 'initial_discovery' };
  const revision = t.resolution.currentRunId
    ? runs.find(run => run.id === t.resolution.currentRunId) ?? null
    : runs.findLast(run => run.role === 'revision' && run.released && run.completion?.status === 'ready_for_review') ?? null;
  const initialMismatch = t.phase === 'needs_attention' && noIdentity && !t.resolution.currentRunId;
  const revisionReconcile = t.phase === 'changes_requested' && t.resumePrNumber === prNumber
    && Boolean(revision?.released && revision.completion?.status === 'ready_for_review');
  if (!initialMismatch && !revisionReconcile)
    return { kind: 'refuse', reason: 'Replacement PR adoption requires an active PR identity repair or completed replacement-PR revision' };
  if (!acceptedReady || !t.completion?.prNumber || prNumber === t.completion.prNumber)
    return { kind: 'refuse', reason: 'Replacement PR adoption requires a different PR for an accepted ready-for-review callback' };
  if ((t.resolution.currentRunId && t.resolution.currentRunId !== revision?.id) || t.resolution.mergeIntent || t.resolution.mergedCommit
    || runs.some(run => !run.released))
    return { kind: 'refuse', reason: 'Replacement PR adoption requires released task runs and no merge intent' };
  return { kind: 'replacement', revision, revisionReconcile };
}

/** Binds an existing PR to a task: identity for a block, recovery or repair otherwise. */
export class PrAdoption {
  constructor(readonly resolution: PrAdoptionContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  paused() { return this.resolution.paused(); }

  /**
   * The retained worker observed inactive in its own task workspace, read through
   * the task's host. One rule for every adoption path: the shared participant
   * predicate, never a per-call status list.
   */
  private async observeStoppedWorker(t: Task): Promise<AgentObservation | null> {
    const state = await this.resolution.onTaskHost(t, () => this.resolution.host.observe(t.agentId!));
    return matchingInactiveParticipant(t, state) ? state : null;
  }
  private async assertStoppedWorker(t: Task, refusal: string): Promise<void> {
    if (!await this.observeStoppedWorker(t)) throw Error(refusal);
  }

  /**
   * Queue #392 (Tom, 2026-10-24): a matching open PR is identity, never readiness.
   *
   * A blocked or errored report is the retained worker's own authenticated block —
   * its reason, its findings and the validation it never ran. Finding the task
   * branch PR must not dispose of it, so this discovery can record the PR's
   * identity and nothing else: the phase, reason, completion, incident, recovery,
   * attention and reviews stay exactly as they were, no run is reserved, and no
   * instruction-free identity confirmation is dispatched to turn the block into
   * review readiness. The retained worker's explicit continuation (`restart
   * role=worker`, `move to=work`) then resumes this same PR with the owner's
   * instruction and the block as context, `move to=review` accepts the delivered
   * scope for review, and the block stays as history. A worker that later sends
   * its own applicable ready result still enters independent review.
   *
   * Identity is recorded only as the canonical source, branch and head just
   * verified, and only at the head the report itself named. Anything else — a
   * fork or unknown head repository, a closed or drafted PR, a branch that moved
   * past the report, a dirty or relocated worktree, an unreachable forge, a live
   * worker, a concurrent owner instruction or a concurrent callback — records one
   * visible reason and leaves the task untouched, so the paced lookup can retry
   * and no reader is told the block advanced.
   */
  async recordBlockedPrIdentity(t: Task, prNumber: number, source: string): Promise<Task> {
    const currentBlock = (task: Task) => retainedProgressRun(this.store, task)?.completion
      ?? (this.store.runs(task.id).some(run => run.role === 'revision' && run.agentId === task.agentId && run.completion)
        ? null : authenticatedWorkerBlock(task));
    const block = currentBlock(t);
    if (!block) return t;
    const deferred = (reason: string) => {
      const detail = `${source}: PR #${prNumber} was not recorded and the authenticated ${block.status} report ${block.eventId} stands; ${reason}`;
      if (!this.store.events(t.id).some(event => event.kind === 'blocked_pr_identity_deferred' && event.detail === detail))
        this.store.event(t.id, 'blocked_pr_identity_deferred', detail);
      return this.store.task(t.id);
    };
    const refusal = (error: unknown) => error instanceof Error ? error.message : String(error);
    if (t.resolution.mergeIntent || t.resolution.mergedCommit) return deferred('the task holds merge intent');
    if (this.store.runs(t.id).some(run => !run.released)) return deferred('another task run is still unresolved');
    if (!t.agentId || !t.workspaceId) return deferred('the task retains no worker to observe');
    let stopped: AgentObservation | null;
    try { stopped = await this.observeStoppedWorker(t); }
    catch (error) { return deferred(`the retained worker cannot be observed (${refusal(error)})`); }
    if (!stopped) return deferred('the retained worker is not observed stopped in its task workspace');
    let pr: VerifiedPr;
    try {
      pr = await this.adapter.verifyPr(t, prNumber);
      assertCanonicalPrSource(pr, prNumber);
    } catch (error) { return deferred(`the PR identity is not established (${refusal(error)})`); }
    if (this.paused()) return deferred('Nucleus paused during the identity proof');
    if (block.head && block.head !== pr.head) return deferred(`the branch is at ${pr.head}, not the head ${block.head} the report named`);
    let confirmed: AgentObservation | null;
    try { confirmed = await this.observeStoppedWorker(t); }
    catch (error) { return deferred(`the retained worker cannot be re-observed (${refusal(error)})`); }
    if (!confirmed) return deferred('the retained worker became active during the identity proof');
    const observed = this.store.task(t.id);
    // A concurrent owner instruction, callback or lifecycle write owns the task from
    // here: the discovery records nothing and reports nothing of its own.
    if (observed.version !== t.version) return observed;
    return this.store.transaction(() => {
      const latest = this.store.task(t.id);
      if (latest.version !== observed.version || currentBlock(latest)?.eventId !== block.eventId
        || latest.prUrl || latest.prHead || latest.resumePrNumber || latest.resolution.mergeIntent || latest.resolution.mergedCommit)
        throw Error(`${source} raced a concurrent change; no PR identity was recorded and the ${block.status} report stands`);
      return this.store.update(t.id, { prUrl: pr.url, prHead: pr.head, resumePrNumber: prNumber }, 'blocked_pr_identity_recorded',
        `${source}: PR #${prNumber} at ${pr.head} recorded as identity only; the authenticated ${block.status} report ${block.eventId} (${block.head ?? 'no reported head'}) stays the task's unresolved block and grants no readiness`);
    });
  }
  /**
   * Bind an existing PR to the task, by the plan its typed state yields: the
   * worker's block keeps identity only, a dead revision recovers its exact branch
   * PR, an initial discovery records the PR and asks its own worker to confirm
   * readiness, and a completed replacement-PR revision reconciles the PR it opened.
   */
  async adoptReplacementPr(t: Task, prNumber: number): Promise<Task> {
    const plan = prAdoptionPlan(t, this.store.runs(t.id), prNumber);
    switch (plan.kind) {
      case 'refuse': throw Error(plan.reason);
      case 'blocked_identity': return this.recordBlockedPrIdentity(t, prNumber, 'Existing branch PR discovery');
      case 'dead_revision': return this.recoverDeadRevisionPr(t, prNumber, plan.runs);
      case 'initial_discovery': return this.reconcileInitialPr(t, prNumber);
      case 'replacement': return this.reconcileReplacementPr(t, prNumber, plan.revision, plan.revisionReconcile);
    }
  }
  /** A revision whose callback was lost: adopt the one exact branch PR and re-ask for readiness. */
  private async recoverDeadRevisionPr(t: Task, prNumber: number, runs: Run[]): Promise<Task> {
    if (t.resolution.mergeIntent || t.resolution.mergedCommit) throw Error('Dead-revision PR recovery requires no merge intent');
    const faultRuns = new Set(this.store.events(t.id).filter(event => event.kind === 'incident').flatMap(event => {
      try {
        const fault = JSON.parse(event.detail) as { runId?: string; cause?: string };
        return fault.runId && ['missing_callback', 'uncertain_delivery'].includes(fault.cause ?? '') ? [fault.runId] : [];
      } catch { return []; }
    }));
    const pending = runs.filter(run => !run.released);
    if (!pending.every(run => run.role === 'revision' && ['running', 'uncertain'].includes(run.status) && run.agentId === t.agentId && run.workspaceId === t.workspaceId && !run.completion
      && (run.status === 'uncertain' || faultRuns.has(run.id))))
      throw Error('Dead-revision PR recovery requires only stopped missing-callback or uncertain-delivery revision runs');
    if (!pending.some(run => run.id === t.resolution.currentRunId)) throw Error('Dead-revision PR recovery requires the current retained revision run');
    if (!this.adapter.findOpenBranchPr || !this.adapter.verifyResume) throw Error('Dead-revision PR recovery verification is unavailable');
    const observed = { version: t.version, agentId: t.agentId, workspaceId: t.workspaceId, directory: t.directory, repoPath: t.repoPath,
      baseBranch: t.baseBranch, branch: t.branch, currentRunId: t.resolution.currentRunId, completionEventId: t.completion?.eventId ?? null,
      runs: pending.map(run => ({ id: run.id, head: run.head, status: run.status })) };
    const stopped = () => this.assertStoppedWorker(t, 'Dead-revision PR recovery requires the retained worker stopped in its task workspace');
    await stopped();
    await this.adapter.verifyResume(t);
    const matches = await this.adapter.findOpenBranchPr(t);
    if (matches.length !== 1 || matches[0].number !== prNumber) throw Error('Dead-revision PR recovery requires exactly one matching open branch PR');
    const pr = await this.adapter.verifyPr(t, prNumber);
    if (pr.head !== matches[0].head || pr.url !== matches[0].url) throw Error('Branch PR changed during dead-revision recovery');
    await stopped();
    await this.adapter.verifyResume(t);
    const confirmed = await this.adapter.verifyPr(t, prNumber);
    if (confirmed.head !== pr.head || confirmed.url !== pr.url) throw Error('Branch PR changed during dead-revision recovery');
    if (this.paused()) throw Error('Nucleus paused during dead-revision PR recovery');
    const current = this.store.task(t.id), latest = this.store.runs(t.id);
    if (current.version !== observed.version || current.agentId !== observed.agentId || current.workspaceId !== observed.workspaceId
      || current.directory !== observed.directory || current.repoPath !== observed.repoPath || current.baseBranch !== observed.baseBranch
      || current.branch !== observed.branch || current.resolution.currentRunId !== observed.currentRunId
      || (current.completion?.eventId ?? null) !== observed.completionEventId
      || current.prUrl || current.prHead || current.resumePrNumber || current.resolution.mergeIntent || current.resolution.mergedCommit
      || latest.filter(run => !run.released).length !== observed.runs.length || observed.runs.some(item => {
        const now = latest.find(run => run.id === item.id);
        return !now || now.released || now.completion || now.head !== item.head || now.status !== item.status || now.agentId !== observed.agentId || now.workspaceId !== observed.workspaceId;
      })) throw Error('Task or revision run changed during dead-revision PR recovery');
    return this.store.transaction(() => {
      for (const item of observed.runs) {
        const retained = latest.find(run => run.id === item.id)!;
        this.store.deleteCredential(retained.id);
        this.store.putRun({ ...retained, released: true });
      }
      const incident = current.resolution.incident ? {
        ...current.resolution.incident, status: 'resolved' as const,
        detail: `Operator reconciled exact branch PR #${prNumber}`, updatedAt: now() } : null;
      return this.store.update(t.id, {
        phase: 'changes_requested', reason: `Exact branch PR #${prNumber} recovered; requesting authenticated readiness confirmation`,
        prUrl: pr.url, prHead: pr.head, resumePrNumber: prNumber,
        resolution: { ...current.resolution, currentRunId: null, review: null, attention: false, recoveryActive: false,
          recovery: null, revisionResumeUnpublished: true, incident } }, 'dead_revision_pr_reconciled', `PR #${prNumber} at ${pr.head}`);
    });
  }
  /** A PR discovered before any run owns it: record the exact identity and ask the retained worker to confirm. */
  private async reconcileInitialPr(t: Task, prNumber: number): Promise<Task> {
    if (t.resolution.mergeIntent || t.resolution.mergedCommit || this.store.runs(t.id).some(run => !run.released))
      throw Error('Initial PR reconciliation requires released runs and no merge intent');
    await this.assertStoppedWorker(t, 'Initial PR reconciliation requires the retained worker to be stopped in its task workspace');
    const pr = await this.adapter.verifyPr(t, prNumber);
    assertCanonicalPrSource(pr, prNumber);
    if (this.paused()) throw Error('Nucleus paused during initial PR verification');
    const current = this.store.task(t.id);
    const confirmed = await this.observeStoppedWorker(t);
    if (current.version !== t.version || (current.completion?.eventId ?? null) !== (t.completion?.eventId ?? null) || current.prUrl || current.prHead || current.resumePrNumber || current.resolution.currentRunId
      || this.store.runs(t.id).some(run => !run.released) || !confirmed)
      throw Error('Task or worker changed during initial PR verification');
    const incident = current.resolution.incident ? {
      ...current.resolution.incident, status: 'resolved' as const,
      detail: `Exact branch PR #${prNumber} reconciled before coordinator recovery`, updatedAt: now() } : null;
    return this.store.update(t.id, {
      phase: 'changes_requested', reason: `Existing PR #${prNumber} discovered; requesting authenticated readiness confirmation`,
      prUrl: pr.url, prHead: pr.head, resumePrNumber: prNumber,
      resolution: { ...current.resolution, currentRunId: null, review: null, attention: false, recoveryActive: false, recovery: null, revisionResumeUnpublished: true, incident } },
      'initial_pr_reconciled', `PR #${prNumber} at ${pr.head}`);
  }
  /** A completed replacement-PR revision, or an identity repair with no bound PR: adopt the verified PR. */
  private async reconcileReplacementPr(t: Task, prNumber: number, revision: Run | null, revisionReconcile: boolean): Promise<Task> {
    const callbackEvent = t.completion!.eventId, revisionEvent = revision?.completion?.eventId ?? null, branch = t.branch;
    const pr = await this.adapter.verifyPr(t, prNumber);
    if (this.paused()) throw Error('Nucleus paused during replacement PR verification');
    const current = this.store.task(t.id);
    const currentRevision = current.resolution.currentRunId ? this.store.run(current.resolution.currentRunId) : revision;
    if (current.phase !== t.phase || current.reason !== t.reason || current.branch !== branch || current.completion?.eventId !== callbackEvent
      || (current.resolution.currentRunId && current.resolution.currentRunId !== currentRevision?.id) || (currentRevision?.completion?.eventId ?? null) !== revisionEvent
      || current.resolution.mergeIntent || current.resolution.mergedCommit || this.store.runs(t.id).some(run => !run.released))
      throw Error('Task changed during replacement PR verification');
    return this.store.update(t.id, {
      phase: 'awaiting_review', reason: `Verified replacement PR #${prNumber}; awaiting independent review`,
      resumePrNumber: prNumber, prHead: pr.head, prUrl: pr.url,
      resolution: { ...current.resolution, attention: false, revisionPrRepair: false, review: null, currentRunId: null },
    }, revisionReconcile ? 'replacement_pr_reconciled' : 'pr_identity_repaired', `PR #${current.completion!.prNumber} → #${prNumber} at ${pr.head}`);
  }
}
