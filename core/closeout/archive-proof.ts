import { existsSync } from 'node:fs';
import type { Engine } from '../engine';
import type { Resolution } from '../resolution';
import { holdsOf, runtimeRetirementFailure, type Run, type Task } from '../../shared/contracts';
import { hookHoldReason } from '../hooks/hooks';
import { buildOutputCleanupHooks, type BuildOutputCleanupHooks } from '../workspaces/worktree-cleanup';
import { workspaceDiscardKey, type WorkspaceDiscard } from '../workspaces/orphan-worktree';
import { assertReviewSourceIdentity, verifyReviewSourceView } from '../review/review-source';
import { hostRunHoldReason } from '../store/store';
import { reportOnlySourceHead } from '../git/index';
import { archiveFailureKeepsScope } from '../workspaces/archive-failure';
import { reconcileGoneWorkspace } from './archive-reconcile';
import { recordArchiveRetry, workspaceArchiveFailureReason, type TerminalWorkspace } from './terminal-archive';

/** The host operations a workspace archive and its runtime retirement ask for. */
export interface LifecycleAdapter {
  workspaceAvailable(id: string): Promise<boolean>;
  createCloseoutWorkspace(task: Task): Promise<{ id: string; directory: string }>;
  findCloseoutWorkspaces(task: Task): Promise<{ id: string; directory: string }[]>;
  verifyCloseoutWorkspace(task: Task, id: string, directory: string): Promise<void>;
  archiveTaskWorkspace(task: Task, id: string, directory: string, expectedHead: string, allowed: () => boolean, uncertain: boolean, requirePublished?: boolean, attachedAgentIds?: ReadonlySet<string>, requireDirectory?: boolean, allowIdleForeignThreads?: boolean, buildOutputCleanup?: BuildOutputCleanupHooks, reviewRun?: Run, discard?: WorkspaceDiscard | null, primaryArchived?: () => boolean, viewSuperseded?: boolean): Promise<boolean | string[]>;
  /** Read-only observation of whether Paseo still lists the workspace; used to reconcile a recorded archive intent. */
  taskWorkspaceArchived?(id: string): Promise<boolean>;
}

type ArchiveAdapter = Engine['adapter'] & Partial<LifecycleAdapter>;

/** The engine, hook and retirement facts one workspace archive proves. */
export type ArchiveProofContext = Pick<Engine, 'adapter' | 'hooks' | 'retirement' | 'stopped' | 'store'> & {
  readonly resolution: Pick<Resolution, 'update'>;
};

/** What one pass of this task's workspace archives looks at. */
export type ArchiveProofFacts = { runs: Run[]; attachedAgentIds: ReadonlySet<string> };

/**
 * The archive proof pipeline for one owned workspace: prove custody, source,
 * ownership, retention and idleness at the exact head, ask the host to archive,
 * and record intent only at the effect boundary. The success transaction writes
 * the archive, clears the intent and captures the retirement scope together, so
 * a crash resumes the same retry instead of repeating a delivery.
 */
export class ArchiveProof {
  constructor(readonly context: ArchiveProofContext) {}
  private get store() { return this.context.store; }
  private get adapter(): ArchiveAdapter { return this.context.adapter as ArchiveAdapter; }
  private paused() { return this.context.stopped || this.store.getMeta('paused') === true; }
  /**
   * The archived ID can also mean that both catalog and disk disappeared
   * without an intent. Require the positive archive event and the scoped
   * retirement captured for this exact primary checkout, on every pass.
   */
  private primaryArchived(task: Task): boolean {
    const current = this.store.task(task.id), primary = current.workspaceId;
    if (!primary || current.directory !== task.directory || !current.resolution.archivedWorkspaceIds.includes(primary)) return false;
    const retirement = current.resolution.runtimeRetirements.find(record => record.workspaceId === primary && record.directory === current.directory);
    if (!retirement || retirement.state !== 'retired' || !retirement.scope || !retirement.provedAt) return false;
    const provedAt = retirement.provedAt;
    return this.store.eventsAll(task.id).some(event => event.kind === 'workspace_archived'
      && event.detail.split('; ').includes(`workspace ${primary}`)
      && !event.detail.includes('observed absent from the catalog and disk without a Queue archive intent')
      && retirement.capturedAt <= event.at && retirement.capturedAt <= provedAt);
  }
  /** Archive one owned workspace, or record the bounded retry that holds it. */
  async archiveWorkspace(task: Task, workspace: TerminalWorkspace, facts: ArchiveProofFacts): Promise<void> {
    const id = workspace.id!;
    try {
      await this.archiveProvedWorkspace(task, { ...workspace, id, directory: workspace.directory! }, facts);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      recordArchiveRetry({ store: this.store, update: this.context.resolution.update }, task.id, id, reason, false);
      // A teardown Paseo reported as failed is not a clean archive either:
      // preserve the failure evidence and any captured token for retry.
      if (archiveFailureKeepsScope(this.context.retirement, task.id, id, error))
        this.context.retirement.flagArchiveFailure(task.id, id, reason);
    }
  }
  private async archiveProvedWorkspace(task: Task, workspace: TerminalWorkspace & { id: string; directory: string },
    facts: ArchiveProofFacts): Promise<void> {
    const { runs, attachedAgentIds } = facts;
    const id = workspace.id, directory = workspace.directory;
    if (runs.some(run => !run.released)) throw Error('Waiting for all task runs to release');
    const hostRun = this.store.hostRunHoldingWorkspace(directory);
    if (hostRun) throw Error(`Waiting: ${hostRunHoldReason(hostRun)}`);
    if (this.store.tasks().some(other => other.id !== task.id && other.phase !== 'done' && ([other.workspaceId, other.resolution.coordinatorWorkspaceId, other.resolution.closeoutWorkspaceId].includes(id) || this.store.runs(other.id).some(run => run.workspaceId === id)))) throw Error('Workspace is referenced by another task');
    const gone = await reconcileGoneWorkspace({
      adapter: this.context.adapter, retirement: this.context.retirement, store: this.store,
      update: this.context.resolution.update, primaryArchived: candidate => this.primaryArchived(candidate),
    }, task, workspace, id, runs);
    if (gone.kind === 'archived') return;
    const archiveUncertain = gone.kind === 'uncertain' ? gone.observed : false;
    // Capture the Effigy runtime scope while the checkout still exists; the
    // durable token survives the archive and drives the retirement proof.
    const runtime = await this.context.retirement.capture(task.id, id, directory);
    if (runs.some(run => run.reviewSourceView?.workspaceId === id) && runtime?.state === 'failed')
      throw Error(`Review workspace runtime retirement failed: ${runtime.error}`);
    // Report-only donor source is bound once here; every later proof and
    // the archive itself require this exact clean, published head.
    // An uncertain intent keeps the head it bound: a report-only source is
    // derived only before any intent, and a pre-head intent keeps the base.
    const intent = this.store.task(task.id).resolution;
    // An owner's recorded content discard for exactly this workspace and
    // directory. Under it no source head is derived through Git: the
    // contents are not claimed, so the recorded head is only the archive's label.
    const discardRecord = this.store.getMeta<WorkspaceDiscard>(workspaceDiscardKey(task.id, id));
    const discard = discardRecord && discardRecord.directory === directory ? discardRecord : null;
    const head = !workspace.reportSource || discard ? workspace.head!
      : intent.archiveIntentWorkspaceId === id ? intent.archiveIntentHead ?? workspace.head!
        : existsSync(directory) ? await reportOnlySourceHead(task, runs) : workspace.head!;
    const reviewRun = runs.find(run => run.reviewSourceView?.workspaceId === id);
    const allowed = () => {
      const current = this.store.task(task.id);
      if (reviewRun) {
        const latest = this.store.run(reviewRun.id);
        if (!latest || JSON.stringify(latest.reviewSourceView) !== JSON.stringify(reviewRun.reviewSourceView)) return false;
        assertReviewSourceIdentity(current, latest, () => this.primaryArchived(task), this.adapter.workspaceIdAccepted?.bind(this.adapter));
      }
      return !this.paused() && current.phase === 'done' && !holdsOf(current).dispatch
        && current.workspaceId === task.workspaceId && current.directory === task.directory && current.branch === task.branch
        && !(id === current.workspaceId && current.reviewEntry?.preserveWorkspace)
        && !this.store.runs(task.id).some(run => !run.released) && !this.store.workspaceUsedByOtherTaskRun(task.id, id) && !this.store.hostRunHoldingWorkspace(directory)
        && !this.store.tasks().some(other => other.id !== task.id &&
          ([other.workspaceId, other.resolution.coordinatorWorkspaceId, other.resolution.closeoutWorkspaceId].includes(id) || other.directory === directory));
    };
    if (reviewRun) await verifyReviewSourceView(this.store.task(task.id), this.store.run(reviewRun.id)!, () => this.primaryArchived(task), this.adapter.workspaceIdAccepted?.bind(this.adapter));
    if (!allowed()) throw Error('Workspace archive held by task identity, ownership or a hold');
    const buildOutputCleanup = buildOutputCleanupHooks(this.store, task.id, id, directory, allowed);
    const primaryArchived = () => this.primaryArchived(task);
    // The consumer-owned retention gate runs in the retained worktree
    // immediately before Queue archives it. A refusal, failure, timeout or
    // uncertainty preserves the worktree and surfaces the hook's evidence.
    const retention = await this.context.hooks.retentionGate(task, { directory, head, reason: `Closeout archive of task workspace ${id}` });
    if (retention.hold) throw Error(hookHoldReason(retention));
    if (reviewRun) await verifyReviewSourceView(this.store.task(task.id), this.store.run(reviewRun.id)!, () => this.primaryArchived(task), this.adapter.workspaceIdAccepted?.bind(this.adapter));
    if (!allowed()) throw Error('Workspace archive held by task identity, ownership or a hold');
    // The adapter calls allowed immediately before archiving. Persist intent at that boundary.
    const archived = await this.adapter.archiveTaskWorkspace!(task, id, directory, head, () => {
      if (!allowed()) return false;
      this.context.resolution.update(this.store.task(task.id), { archiveIntentWorkspaceId: id, archiveIntentHead: head }, {}, 'workspace_archive_intent', head);
      return true;
    }, archiveUncertain, true, attachedAgentIds, false, !reviewRun, buildOutputCleanup, reviewRun, discard, primaryArchived);
    if (!archived) {
      // The adapter declined without any effect: no native archive request was
      // sent and nothing was deleted. A retained build-output root is a named,
      // durable cause that has not changed, so it joins the ordinary bounded
      // retry the thrown refusals already use: the next audit pass inside that
      // interval does no proof work at all, while the due pass - and an owner
      // `retry_effect`, which is never held by the interval - re-proves custody,
      // ownership, source, publication, retention and idleness before any effect.
      // A hold or a pause declines through fences that clear themselves, so it
      // records nothing here and keeps its immediate next pass.
      const retained = this.store.task(task.id).resolution.buildOutputCleanups
        .find(item => item.workspaceId === id && !item.runId && (item.state === 'skipped' || item.state === 'uncertain'));
      if (retained) recordArchiveRetry({ store: this.store, update: this.context.resolution.update }, task.id, id, retained.detail, true);
      return;
    }
    const foreign = Array.isArray(archived) ? archived : [];
    if (discard) this.store.event(task.id, 'workspace_contents_discarded', JSON.stringify({ ...discard, detail: 'Unproven contents discarded: no clean or published source is claimed' }));
    const detail = [foreign.length ? `foreign threads ${foreign.join(',')}` : 'workspace_archived',
      ...(discard ? [`unproven contents discarded by ${discard.caller} (${discard.authority})`] : []),
      ...(head !== workspace.head ? [`report-only source ${head} preserved on ${task.branch}`] : []),
      // The archived workspace is named, so a replayed retry can tie this outcome to its own effect.
      `workspace ${id}`].join('; ');
    const latest = this.store.task(task.id);
    // The archive-success transaction flips the captured scope to `pending`:
    // a crash before the proof now resumes the same `--scope` retry on restart.
    const runtimeRetirements = this.context.retirement.markArchived(latest, id);
    const workspaceArchiveRetries = latest.resolution.workspaceArchiveRetries.filter(record => record.workspaceId !== id);
    this.context.resolution.update(latest, {
      archivedWorkspaceIds: [...new Set([...latest.resolution.archivedWorkspaceIds, id])],
      archiveIntentWorkspaceId: null, archiveIntentHead: null, workspaceArchiveRetries,
      cleanupReason: runtimeRetirementFailure({ resolution: { ...latest.resolution, runtimeRetirements } }) || workspaceArchiveFailureReason(workspaceArchiveRetries),
      runtimeRetirements,
    }, {}, 'workspace_archived', detail);
    await this.context.retirement.archived(task.id, id);
  }
}
