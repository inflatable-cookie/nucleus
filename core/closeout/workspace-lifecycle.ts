import type { Resolution } from '../resolution';
import { workspaceDiscardKey, type WorkspaceDiscard } from '../workspaces/orphan-worktree';
import { existsSync, lstatSync, realpathSync } from "node:fs";
import type { Run } from "../../shared/contracts";
import {doublingDelay} from '../../shared/backoff';
import type {Task} from '../../shared/contracts';
import {holdsOf,isDispositionActive,runtimeRetirementFailure} from '../../shared/contracts';
import {OWNER_STOP_HOLD_PREFIX,releasePatch} from '../merge/merge-hold';
import type {Engine} from '../engine';
import {hookHoldReason} from '../hooks/hooks';
import { CloseoutRecovery } from './recovery';
import { closeoutContext } from './context';
import {buildOutputCleanupHooks, type BuildOutputCleanupHooks} from '../workspaces/worktree-cleanup';
import {externalWorkspaceArchiveDue,settleExternalWorkspaceArchive} from '../workspaces/external-workspace-archive';
import {buildOutputCleanupReasonPrefix} from '../hooks/build-output-records';
import {hostProcessSweepIntent,sweepTaskHostProcesses} from '../machine/host-process-reap';
import {git, originBranchContaining, reportOnlySourceHead, verifyRecordedOrigin} from '../git/index';
import {assertReviewSourceBinding, assertReviewSourceIdentity, verifyReviewSourceView} from '../review/review-source';
import {archiveIntentOutstanding,archiveIntentUnreadable,archiveSettledByOwner} from '../workspaces/archive-intent';
import {isTransportFailure} from '../../shared/transport';
import {hostRunHoldReason} from '../store/store';
import {missingOriginHasPlanner} from '../questions/origin';
import {admissionOf,isBackpressureDeferral} from '../host/admission';
import {isLoginSessionFault,LoginSessionFaultError} from '../../shared/session-fault';
export { CONSUMER_BLOCK_RENEWAL_LIMIT } from "./recovery";
const WORKSPACE_ARCHIVE_RETRY_BASE_MS = 60_000;
const WORKSPACE_ARCHIVE_RETRY_MAX_MS = 60 * 60_000;
function workspaceArchiveRetryDelay(attempts: number) {
  return doublingDelay(WORKSPACE_ARCHIVE_RETRY_BASE_MS, WORKSPACE_ARCHIVE_RETRY_MAX_MS, attempts);
}
/**
 * Whether a recorded archive retry still waits on its backoff. A breaker
 * deferral never reached Paseo, so it is not a failure to back off from: it is
 * due again on the first pass the breaker admits, like a deferred title.
 */
function archiveRetryWaiting(retry: Task['resolution']['workspaceArchiveRetries'][number] | undefined) {
  return Boolean(retry && !isBackpressureDeferral(retry.error) && Date.parse(retry.nextAttemptAt) > Date.now());
}
function workspaceArchiveFailureReason(retries: Task['resolution']['workspaceArchiveRetries']) {
  const retry = retries[0];
  return retry ? `Workspace archive for ${retry.workspaceId} failed: ${retry.error}` : '';
}
/** The same terminal workspace identities drive automatic cleanup and owner retries. */
/**
 * How a finished task's source settles for archive. A proof-only task has a detached
 * checkout at its commit and no branch, so it is never a report-only source, however
 * it ended: a pass, a failure or an owner's acceptance of an interrupted run.
 */
export function terminalArchiveSource(task:Task):{reportOnly:boolean;proofOnlyDone:boolean} {
  const proofOnly=Boolean(task.entrypoint==='proof'&&task.proofOnly);
  return {
    reportOnly:!proofOnly&&Boolean(task.reportAcceptance&&!task.prUrl&&!task.prHead&&!task.resolution.mergedCommit&&!task.resolution.syncedCommit),
    proofOnlyDone:proofOnly&&task.phase==='done',
  };
}
export function terminalArchiveWorkspaces(task:Task,runs:Run[]) {
  const {reportOnly,proofOnlyDone}=terminalArchiveSource(task);
  if(task.phase!=='done'||(!reportOnly&&!proofOnlyDone&&(!task.resolution.mergedCommit||!task.resolution.syncedCommit)))return [];
  return [
    // A report-only workspace starts at its planning base; the archive derives
    // any preserved donor source beyond it from current Git evidence.
    {id:task.reviewEntry?.preserveWorkspace ? null : task.workspaceId,directory:task.directory,
      head:reportOnly ? task.planningBase : proofOnlyDone ? task.proofOnly!.commit : task.prHead,reportSource:reportOnly},
    {id:task.resolution.closeoutWorkspaceId,directory:task.resolution.closeoutDirectory,head:task.resolution.closeoutWorkspaceHead},
    ...runs.filter(run=>run.reviewSourceView?.directory).map(run=>({id:run.workspaceId,directory:run.reviewSourceView!.directory,head:run.head})),
  ].filter((workspace,index,owned)=>owned.findIndex(other=>other.id===workspace.id)===index);
}
export interface LifecycleAdapter {
  workspaceAvailable(id:string):Promise<boolean>;
  createCloseoutWorkspace(task:Task):Promise<{id:string;directory:string}>;
  findCloseoutWorkspaces(task:Task):Promise<{id:string;directory:string}[]>;
  verifyCloseoutWorkspace(task:Task,id:string,directory:string):Promise<void>;
  archiveTaskWorkspace(task:Task,id:string,directory:string,expectedHead:string,allowed:()=>boolean,uncertain:boolean,requirePublished?:boolean,attachedAgentIds?:ReadonlySet<string>,requireDirectory?:boolean,allowIdleForeignThreads?:boolean,buildOutputCleanup?:BuildOutputCleanupHooks,reviewRun?:Run,discard?:WorkspaceDiscard|null,primaryArchived?:()=>boolean,viewSuperseded?:boolean):Promise<boolean|string[]>;
  /** Read-only observation of whether Paseo still lists the workspace; used to reconcile a recorded archive intent. */
  taskWorkspaceArchived?(id:string):Promise<boolean>;
}
export type LifecycleContext = Pick<Engine, 'adapter' | 'drainCleanup' | 'enqueueCleanup' | 'hooks' | 'host' | 'removeSiblings' | 'retirement' | 'scheduleRetirement' | 'scheduleRunBuildOutputs' | 'settleObservedIdleRuns' | 'settleTerminalIntentRuns' | 'settleTerminalRecoveryEpisode' | 'stopped' | 'store' | 'taskHostAvailable' | 'withHost'> & { readonly resolution: Pick<Resolution, 'adapter' | 'closeoutAuthority' | 'hasEarlierIntegrationTurn' | 'lease' | 'attention' | 'environmentDeferred' | 'transportDeferred' | 'update'> };

export class Lifecycle {
  private readonly closeoutRecovery: CloseoutRecovery;
  constructor(readonly engine:LifecycleContext){
    this.closeoutRecovery = new CloseoutRecovery({
      get adapter() { return engine.adapter; },
      get host() { return engine.host; },
      get resolution() { return closeoutContext(engine.resolution, ['adapter', 'closeoutAuthority', 'hasEarlierIntegrationTurn', 'lease', 'update']); },
      get stopped() { return engine.stopped; },
      get store() { return engine.store; },
    });
  }
  get store(){return this.engine.store;}
  get adapter(){return this.engine.adapter as typeof this.engine.adapter & Partial<LifecycleAdapter>;}
  paused(){return this.engine.stopped || this.store.getMeta('paused')===true;}
  private primaryArchived(task:Task):boolean {
    const current=this.store.task(task.id), primary=current.workspaceId;
    if(!primary||current.directory!==task.directory||!current.resolution.archivedWorkspaceIds.includes(primary))return false;
    const retirement=current.resolution.runtimeRetirements.find(record=>record.workspaceId===primary&&record.directory===current.directory);
    if(!retirement||retirement.state!=='retired'||!retirement.scope||!retirement.provedAt)return false;
    const provedAt=retirement.provedAt;
    return this.store.eventsAll(task.id).some(event=>event.kind==='workspace_archived'
      &&event.detail.split('; ').includes(`workspace ${primary}`)
      &&!event.detail.includes('observed absent from the catalog and disk without a Queue archive intent')
      &&retirement.capturedAt<=event.at&&retirement.capturedAt<=provedAt);
  }
  recover(task:Task) { return this.closeoutRecovery.recover(task); }
  private renewStaleCloseoutBase(task: Task) { return this.closeoutRecovery.renewStaleCloseoutBase(task); }
  get consumerBlockFetchMs() { return this.closeoutRecovery.consumerBlockFetchMs; }
  set consumerBlockFetchMs(value: number) { this.closeoutRecovery.consumerBlockFetchMs = value; }
  private renewConsumerBlockedCloseout(task:Task) { return this.closeoutRecovery.renewConsumerBlockedCloseout(task); }
  /** A passed retention reconciliation makes the retained workspace ready for immediate cleanup. */
  retentionReconciled(taskId:string,workspaceId:string|null) {
    const current=this.store.task(taskId);
    if(workspaceId){
      const retries=current.resolution.workspaceArchiveRetries;
      const workspaceArchiveRetries=retries.filter(record=>record.workspaceId!==workspaceId);
      if(workspaceArchiveRetries.length!==retries.length){
        const archiveFailure=workspaceArchiveFailureReason(retries);
        const cleanupReason=current.resolution.cleanupReason===archiveFailure
          ? runtimeRetirementFailure(current)||workspaceArchiveFailureReason(workspaceArchiveRetries)
          : current.resolution.cleanupReason;
        this.engine.resolution.update(current,{workspaceArchiveRetries,cleanupReason},{},'workspace_archive_retry_cleared',workspaceId);
      }
    }
    this.engine.enqueueCleanup(taskId);
  }
  /**
   * One pass over the preserved external workspace's catalog archive. The
   * module owns the record, the at-most-once identity and the bounded retry;
   * this method only gives it the engine's adapter, pause fence and the
   * versioned resolution write.
   */
  private async settlePreservedCatalogArchive(task: Task, retryWorkspaceId?: string): Promise<Task> {
    try {
      return await settleExternalWorkspaceArchive({
        store: this.store, adapter: this.adapter, paused: () => this.paused(),
        resolution: this.engine.resolution,
      }, task.id, retryWorkspaceId);
    } catch (error) {
      this.store.event(task.id, 'external_workspace_archive_warning', error instanceof Error ? error.message : String(error));
      return this.store.task(task.id);
    }
  }
  /**
   * Settle a passed pre-archive gate. The gate names the retained worktree it ran in,
   * not a workspace identity, so map that directory to the owned workspace it belongs
   * to (primary, closeout or a reviewer source view) before clearing only that
   * workspace's archive backoff. An unknown directory settles nothing.
   */
  retentionReconciledAt(taskId:string,worktree:string|null) {
    if(!worktree)return;
    const task=this.store.task(taskId);
    const runs=this.store.runs(taskId);
    const owned=[
      {id:task.workspaceId,directory:task.directory},
      {id:task.resolution.closeoutWorkspaceId,directory:task.resolution.closeoutDirectory},
      ...runs.filter(run=>run.reviewSourceView?.directory).map(run=>({id:run.workspaceId,directory:run.reviewSourceView!.directory})),
    ];
    const match=owned.find(workspace=>workspace.id&&workspace.directory===worktree);
    if(match?.id)this.retentionReconciled(taskId,match.id);
  }
  /**
   * Whether this pass owes any archive effect. A workspace archive that already
   * succeeded, or whose recorded bounded retry is not due yet, owes nothing: its
   * finished hook, its manifest discovery and its host-process sweep were owed by
   * the terminal transition, whose own durable intents (`finishedHook`,
   * `hostProcessSweep`) are the restart authority and are still honoured here.
   * A pause, ownership or content proof only ever refuses an attempt after this
   * point, so gating on due work changes no gate - it only stops re-proving them
   * on passes that cannot act.
   */
  private archiveWorkDue(task: Task, retryWorkspaceId?: string): boolean {
    if (task.resolution.finishedHook || task.resolution.hostProcessSweep) return true;
    if (externalWorkspaceArchiveDue(task, retryWorkspaceId)) return true;
    const runs = this.store.runs(task.id);
    return terminalArchiveWorkspaces(task, runs).some(workspace => {
      if (!workspace.id || !workspace.directory || !workspace.head) return false;
      if (retryWorkspaceId !== workspace.id && archiveSettledByOwner(task, workspace.id)) return false;
      const source = runs.find(run => run.workspaceId === workspace.id)?.reviewSourceView?.sourceDirectory;
      if (task.resolution.archivedWorkspaceIds.includes(workspace.id)) return false;
      if (retryWorkspaceId) return retryWorkspaceId === workspace.id;
      return !archiveRetryWaiting(task.resolution.workspaceArchiveRetries.find(record => record.workspaceId === workspace.id));
    });
  }
  /** A finished task's owner-stop dispatch hold is released; it has no work left to stop. */
  private releaseFinishedStopHold(task:Task):Task{
    const hold=holdsOf(task).dispatch;
    if(task.phase!=='done'||!hold||!hold.reason.startsWith(OWNER_STOP_HOLD_PREFIX))return task;
    return this.store.update(task.id,releasePatch(task,'dispatch'),'hold_released',
      `Dispatch hold released: the task finished, so its owner stop (${hold.reason.slice(0,300)}) has no work left to stop`);
  }
  /**
   * A nonterminal task owes no archive of its own. One durable
   * `archiveIntentWorkspaceId` can still outlive a task removal whose native reply
   * was lost, so an intent naming no reviewer run is reported with whatever the
   * catalog still answers. An unknown outcome is observed, never re-sent.
   */
  private async observeUnreadableArchiveIntent(task: Task, retryWorkspaceId?: string) {
    const archiveTaskWorkspace = this.adapter.archiveTaskWorkspace;
    if (!archiveTaskWorkspace) return;
    const runs = this.store.runs(task.id);
    const unreadable = archiveIntentUnreadable(task, runs, retryWorkspaceId);
    if (unreadable) {
      // The same interval governs an unreadable intent's catalog observation, so a
      // recorded backoff is not re-read on every sweep; an owner retry still runs.
      const unreadableRetry = this.store.task(task.id).resolution.workspaceArchiveRetries.find(record => record.workspaceId === unreadable);
      if (retryWorkspaceId !== unreadable && unreadableRetry && Date.parse(unreadableRetry.nextAttemptAt) > Date.now()) return;
      if (!this.paused()) {
        let observation = '';
        if (this.adapter.taskWorkspaceArchived) {
          // `taskWorkspaceArchived` answers true when the entry is gone from the
          // catalog: read it that way round, never backwards.
          try { observation = await this.adapter.taskWorkspaceArchived(unreadable)
            ? '; the catalog no longer lists that workspace entry' : '; the catalog still lists that workspace entry'; }
          catch { observation = '; the catalog observation was unavailable'; }
        }
        // Every due observation is one bounded occurrence: recording it advances the
        // deadline even when the answer is unchanged, so the next sweep inside the
        // new interval reads nothing.
        this.recordArchiveRetry(task.id, unreadable,
          `The recorded review view archive intent no longer matches a reviewer run, so its checkout and publication cannot be re-proved${observation}. Inspect that workspace entry before retrying`, false);
      }
      return;
    }
  }
  async archive(task:Task,retryWorkspaceId?:string) {
    // A terminal task's stale recovery episode settles before any gate below can
    // return: a cancelled task never reaches the done-only archive, and a done task
    // without a recorded merge stops at the merge guard. The settlement is store-only.
    if (['done','cancelled'].includes(task.phase) && task.resolution.recoveryActive) {
      this.engine.settleTerminalRecoveryEpisode(task.id,'end-of-task cleanup');
      task=this.store.task(task.id);
    }
    if (task.phase !== 'done' && (task.originError&&!missingOriginHasPlanner(this.store,task) || task.originLookupError || this.paused() || !this.adapter.archiveTaskWorkspace)) return;
    if (task.phase !== 'done') return this.observeUnreadableArchiveIntent(task, retryWorkspaceId);
    const {reportOnly,proofOnlyDone} = terminalArchiveSource(task);
    if(task.originError&&!missingOriginHasPlanner(this.store,task) || task.originLookupError || this.paused() || task.phase!=='done'
      || (!reportOnly && !proofOnlyDone && (!task.resolution.mergedCommit || !task.resolution.syncedCommit)) || !this.adapter.archiveTaskWorkspace)return;
    // Degraded admission defers archive work as it defers titles: no attempt is
    // made or recorded, and the next healthy pass finds the same work due. An
    // owner retry still runs, so its refusal is reported rather than swallowed.
    if(!retryWorkspaceId&&admissionOf(this.adapter)?.degradedNow)return;
    // An owner stop pauses work; a finished task has none left, so its stop hold
    // stops nothing and would only refuse the archive for good (#456, Effigy #377,
    // Tom 2026-10-26: "It keeps happening!"). Release it, recorded, before archiving.
    // Any other dispatch hold is a deliberate preservation and still keeps the workspace.
    task=this.releaseFinishedStopHold(task);
    // Spec 050 terminal-cleanup liveness (papercut b87375b0): a never-reporting
    // run whose agent is observed idle, with no active turn and no pending
    // permission, is released with history kept before the archive waits on it.
    // This runs before the recoveryActive gate because such a run is exactly
    // what keeps the recovery episode reading active.
    if(task.resolution.recoveryActive || this.store.runs(task.id).some(run=>!run.released)){
      await this.engine.settleObservedIdleRuns(task.id,'End-of-task cleanup released an idle run with no live turn');
      task=this.store.task(task.id);
    }
    if(task.resolution.recoveryActive)return;
    // The advisory finished-task runtime stop and the terminal host-process
    // sweep are expensive (three to five Git spawns, `ps` and `lsof`) and only
    // owed once per terminal transition, so they run on a pass that is actually
    // due - a due owned-workspace archive, a due preserved catalog archive or
    // the durable terminal-transition intents - never on every pass of a
    // workspace whose retry is still backed off.
    if (this.archiveWorkDue(task, retryWorkspaceId)) {
      try { await this.engine.hooks.finished(task); }
      catch (error) { this.store.event(task.id, 'finished_hook_warning', `task.finished could not run: ${error instanceof Error ? error.message : String(error)}`); }
      try { await sweepTaskHostProcesses(this.store, this.store.task(task.id)); }
      catch (error) { this.store.event(task.id, 'host_process_sweep_warning', `Host process sweep could not run: ${error instanceof Error ? error.message : String(error)}`); }
    }
    // Spec 027: sibling worktrees leave with the task's own workspaces.
    if(task.siblingPins.length) await this.engine.removeSiblings(task.id);
    // Spec 017: a merged review-entry task's preserved external workspace keeps
    // its folder; only Paseo's sidebar entry is archived, and only behind the
    // adapter's source-backed placement proof. It runs before the owned-workspace
    // loop so a held owned archive never delays it, and it never throws into that
    // loop: its own durable record and events are the visible state.
    task = await this.settlePreservedCatalogArchive(task, retryWorkspaceId);
    const runs=this.store.runs(task.id);
    const attachedAgentIds=new Set([task.agentId,task.coordinatorAgentId,task.resolution.reviewerAgentId,
      ...task.retiredWorkers.map(worker=>worker.agentId),...runs.map(run=>run.agentId)].filter((id):id is string=>Boolean(id)));
    for(const workspace of terminalArchiveWorkspaces(task,runs)){
      if(!workspace.id||!workspace.directory||!workspace.head||task.resolution.archivedWorkspaceIds.includes(workspace.id))continue;
      const id=workspace.id;
      if(retryWorkspaceId!==id&&archiveSettledByOwner(this.store.task(task.id),id))continue;
      if(retryWorkspaceId&&retryWorkspaceId!==id)continue;
      const retry=this.store.task(task.id).resolution.workspaceArchiveRetries.find(record=>record.workspaceId===id);
      // An owner retries this workspace now without erasing its failed attempts
      // or uncertain intent. All ordinary archive proofs below still apply.
      const recordedReview = runs.find(run => run.reviewSourceView?.workspaceId === id);
      if(!retryWorkspaceId&&archiveRetryWaiting(retry))continue;
      try{
        if(runs.some(r=>!r.released))throw Error('Waiting for all task runs to release');
        const directory=workspace.directory;
        const hostRun=this.store.hostRunHoldingWorkspace(directory);
        if(hostRun)throw Error(`Waiting: ${hostRunHoldReason(hostRun)}`);
        if(this.store.tasks().some(t=>t.id!==task.id&&t.phase!=='done'&&([t.workspaceId,t.resolution.coordinatorWorkspaceId,t.resolution.closeoutWorkspaceId].includes(id)||this.store.runs(t.id).some(r=>r.workspaceId===id))))throw Error('Workspace is referenced by another task');
        // An interrupted first attempt leaves intent without result, and a
        // workspace removed outside Queue leaves no intent at all. Either way,
        // observe before the pre-archive hooks: they run in the retained
        // worktree, so a hook failure or a stale refusal on an already-removed
        // checkout must not strand the gone-workspace success transaction below
        // (Project-a #1900). Disposition observes the same way.
        let archiveUncertain=false;
        const intended=this.store.task(task.id).resolution.archiveIntentWorkspaceId===id;
        if(intended||(this.adapter.taskWorkspaceArchived&&!existsSync(workspace.directory))){
          if(!this.adapter.taskWorkspaceArchived)throw Error(`Waiting to reconcile the uncertain workspace archive for ${id}: workspace observation is unavailable`);
          let observed:boolean;
          try{observed=await this.adapter.taskWorkspaceArchived(id);}
          catch(error){
            if(intended)throw Error(`Waiting to reconcile the uncertain workspace archive for ${id}: ${error instanceof Error?error.message:String(error)}`);
            observed=false; // No intent: an unanswered observation leaves the ordinary archive path.
          }
          if(observed&&!existsSync(workspace.directory)){
            const reviewRun=runs.find(run=>run.reviewSourceView?.workspaceId===id);
            if(reviewRun){
              const view=reviewRun.reviewSourceView!;
              if(!intended||this.store.task(task.id).resolution.archiveIntentHead!==view.head)
                throw Error('Missing review view has no matching archive intent');
              assertReviewSourceBinding(this.store.task(task.id),reviewRun,this.adapter.workspaceIdAccepted?.bind(this.adapter));
              if(view.state!=='ready'||!this.primaryArchived(task))throw Error('Missing review view lacks primary archive and retirement proof');
              // With the target gone an alias cannot be independently checked.
              // Keep the uncertain effect when the original path reappears.
              try { lstatSync(view.sourceDirectory); throw Error('Missing review view has a recreated primary source'); }
              catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
              if(realpathSync(await git(task.repoPath,'rev-parse','--path-format=absolute','--git-common-dir'))!==view.commonDir
                ||await git(task.repoPath,'config','--get','remote.origin.url')!==view.origin)
                throw Error('Pinned review canonical Git identity changed');
              await verifyRecordedOrigin(task,task.repoPath);
              if(!await originBranchContaining(task.repoPath,view.head,[task.branch,task.baseBranch]))
                throw Error('Missing review view is not published on the canonical origin');
              if(!this.primaryArchived(task)||this.store.task(task.id).resolution.archiveIntentWorkspaceId!==id
                ||this.store.task(task.id).resolution.archiveIntentHead!==view.head)
                throw Error('Review archive proof changed during reconciliation');
            }
            const latest=this.store.task(task.id);
            const runtimeRetirements=this.engine.retirement.markArchived(latest,id);
            const workspaceArchiveRetries=latest.resolution.workspaceArchiveRetries.filter(record=>record.workspaceId!==id);
            task=this.engine.resolution.update(latest,{archivedWorkspaceIds:[...new Set([...latest.resolution.archivedWorkspaceIds,id])],archiveIntentWorkspaceId:null,archiveIntentHead:null,workspaceArchiveRetries,cleanupReason:runtimeRetirementFailure({resolution:{...latest.resolution,runtimeRetirements}})||workspaceArchiveFailureReason(workspaceArchiveRetries),runtimeRetirements}, {},'workspace_archived',`${intended?'workspace_archived':'workspace_archived; observed absent from the catalog and disk without a Queue archive intent'}; workspace ${id}`);
            await this.engine.retirement.archived(task.id,id);
            continue;
          }
          if(intended)archiveUncertain=observed; // Absent catalog with retained source permits only local teardown.
          // A present catalog observation permits the same guarded native
          // request. Absence with a retained directory permits local teardown
          // only; a catalog reappearance must not turn it into a native replay.
        }
        // Capture the Effigy runtime scope while the checkout still exists; the
        // durable token survives the archive and drives the retirement proof.
        const runtime=await this.engine.retirement.capture(task.id,id,workspace.directory);
        if(runs.some(run=>run.reviewSourceView?.workspaceId===id)&&runtime?.state==='failed')
          throw Error(`Review workspace runtime retirement failed: ${runtime.error}`);
        // Report-only donor source is bound once here; every later proof and
        // the archive itself require this exact clean, published head.
        // An uncertain intent keeps the head it bound: a report-only source is
        // derived only before any intent, and a pre-head intent keeps the base.
        const intent=this.store.task(task.id).resolution;
        // An owner's recorded content discard for exactly this workspace and
        // directory. Under it no source head is derived through Git: the
        // contents are not claimed, so the recorded head is only the archive's label.
        const discardRecord=this.store.getMeta<WorkspaceDiscard>(workspaceDiscardKey(task.id,id));
        const discard=discardRecord&&discardRecord.directory===workspace.directory?discardRecord:null;
        const head=!workspace.reportSource||discard?workspace.head
          :intent.archiveIntentWorkspaceId===id?intent.archiveIntentHead??workspace.head
          :existsSync(workspace.directory)?await reportOnlySourceHead(task,runs):workspace.head;
        const reviewRun=runs.find(run=>run.reviewSourceView?.workspaceId===id);
        const allowed=()=>{
          const current=this.store.task(task.id);
          if(reviewRun){
            const latest=this.store.run(reviewRun.id);
            if(!latest||JSON.stringify(latest.reviewSourceView)!==JSON.stringify(reviewRun.reviewSourceView))return false;
            assertReviewSourceIdentity(current,latest,()=>this.primaryArchived(task),this.adapter.workspaceIdAccepted?.bind(this.adapter));
          }
          return !this.paused()&&current.phase==='done'&&!holdsOf(current).dispatch
            &&current.workspaceId===task.workspaceId&&current.directory===task.directory&&current.branch===task.branch
            &&!(id===current.workspaceId&&current.reviewEntry?.preserveWorkspace)
            &&!this.store.runs(task.id).some(run=>!run.released)&&!this.store.workspaceUsedByOtherTaskRun(task.id,id)&&!this.store.hostRunHoldingWorkspace(directory)
            &&!this.store.tasks().some(other=>other.id!==task.id&&
              ([other.workspaceId,other.resolution.coordinatorWorkspaceId,other.resolution.closeoutWorkspaceId].includes(id)||other.directory===workspace.directory));
        };
        if(reviewRun) await verifyReviewSourceView(this.store.task(task.id),this.store.run(reviewRun.id)!,()=>this.primaryArchived(task),this.adapter.workspaceIdAccepted?.bind(this.adapter));
        if(!allowed())throw Error('Workspace archive held by task identity, ownership or a hold');
        const buildOutputCleanup=buildOutputCleanupHooks(this.store,task.id,id,workspace.directory,allowed);
        // The archived ID can also mean that both catalog and disk disappeared
        // without an intent. Require the positive archive event and the scoped
        // retirement captured for this exact primary checkout, on every pass.
        const primaryArchived=()=>this.primaryArchived(task);
        // The consumer-owned retention gate runs in the retained worktree
        // immediately before Queue archives it. A refusal, failure, timeout or
        // uncertainty preserves the worktree and surfaces the hook's evidence.
        const retention=await this.engine.hooks.retentionGate(task,{directory:workspace.directory,head,reason:`Closeout archive of task workspace ${id}`});
        if(retention.hold)throw Error(hookHoldReason(retention));
        if(reviewRun) await verifyReviewSourceView(this.store.task(task.id),this.store.run(reviewRun.id)!,()=>this.primaryArchived(task),this.adapter.workspaceIdAccepted?.bind(this.adapter));
        if(!allowed())throw Error('Workspace archive held by task identity, ownership or a hold');
        // The adapter calls allowed immediately before archiving. Persist intent at that boundary.
        const archived=await this.adapter.archiveTaskWorkspace(task,id,workspace.directory,head,()=>{
          if(!allowed())return false;
          this.engine.resolution.update(this.store.task(task.id),{archiveIntentWorkspaceId:id,archiveIntentHead:head}, {},'workspace_archive_intent',head);return true;
        },archiveUncertain,true,attachedAgentIds,false,!reviewRun,buildOutputCleanup,reviewRun,discard,primaryArchived);
        if(!archived){
          // The adapter declined without any effect: no native archive request was
          // sent and nothing was deleted. A retained build-output root is a named,
          // durable cause that has not changed, so it joins the ordinary bounded
          // retry the thrown refusals already use: the next audit pass inside that
          // interval does no proof work at all, while the due pass - and an owner
          // `retry_effect`, which is never held by the interval - re-proves custody,
          // ownership, source, publication, retention and idleness before any effect.
          // A hold or a pause declines through fences that clear themselves, so it
          // records nothing here and keeps its immediate next pass.
          const retained=this.store.task(task.id).resolution.buildOutputCleanups
            .find(item=>item.workspaceId===id&&!item.runId&&(item.state==='skipped'||item.state==='uncertain'));
          if(retained)this.recordArchiveRetry(task.id,id,retained.detail,true);
          return;
        }
        const foreign=Array.isArray(archived)?archived:[];
        if(discard)this.store.event(task.id,'workspace_contents_discarded',JSON.stringify({...discard,detail:'Unproven contents discarded: no clean or published source is claimed'}));
        const detail=[foreign.length?`foreign threads ${foreign.join(',')}`:'workspace_archived',
          ...(discard?[`unproven contents discarded by ${discard.caller} (${discard.authority})`]:[]),
          ...(head!==workspace.head?[`report-only source ${head} preserved on ${task.branch}`]:[]),
          // The archived workspace is named, so a replayed retry can tie this outcome to its own effect.
          `workspace ${id}`].join('; ');
        const latest=this.store.task(task.id);
        // The archive-success transaction flips the captured scope to `pending`:
        // a crash before the proof now resumes the same `--scope` retry on restart.
        const runtimeRetirements=this.engine.retirement.markArchived(latest,id);
        const workspaceArchiveRetries=latest.resolution.workspaceArchiveRetries.filter(record=>record.workspaceId!==id);
        task=this.engine.resolution.update(latest,{archivedWorkspaceIds:[...new Set([...latest.resolution.archivedWorkspaceIds,id])],archiveIntentWorkspaceId:null,archiveIntentHead:null,workspaceArchiveRetries,cleanupReason:runtimeRetirementFailure({resolution:{...latest.resolution,runtimeRetirements}})||workspaceArchiveFailureReason(workspaceArchiveRetries),runtimeRetirements}, {},'workspace_archived',detail);
        await this.engine.retirement.archived(task.id,id);
      }catch(error){
        const reason=error instanceof Error?error.message:String(error);
        this.recordArchiveRetry(task.id,id,reason,false);
        // A teardown Paseo reported as failed is not a clean archive either:
        // preserve the failure evidence and any captured token for retry.
        if(/teardown/i.test(reason)||(this.engine.retirement.hasScope(task.id,id)&&/retire|runtime scope/i.test(reason)))this.engine.retirement.flagArchiveFailure(task.id,id,reason);
        continue;
      }
    }
  }
  /**
   * Record the existing bounded archive retry for one workspace, keeping every
   * other workspace's record. A thrown refusal names its own cause, which
   * replaces a bound build-output reason; a declined attempt has no error of its
   * own, so it keeps the reason its durable build-output record already names.
   * The attempts and the doubling delay are the existing ones: this adds no
   * suppression and no new stored shape.
   */
  private recordArchiveRetry(taskId:string,id:string,reason:string,keepNamedReason:boolean){
    const current=this.store.task(taskId);
    const previous=current.resolution.workspaceArchiveRetries.find(record=>record.workspaceId===id);
    // A breaker deferral is not an attempt: it neither counts nor doubles the delay.
    const deferred=isBackpressureDeferral(reason);
    const attempts=(previous?.attempts??0)+(deferred?0:1);
    const nextAttemptAt=new Date(Date.now()+(deferred?0:workspaceArchiveRetryDelay(attempts))).toISOString();
    const workspaceArchiveRetries=[...current.resolution.workspaceArchiveRetries.filter(record=>record.workspaceId!==id),
      {workspaceId:id,attempts,error:reason.slice(0,2000),nextAttemptAt}];
    const named=keepNamedReason&&current.resolution.cleanupReason.startsWith(buildOutputCleanupReasonPrefix)
      ?current.resolution.cleanupReason:'';
    const cleanupReason=runtimeRetirementFailure(current)||named||workspaceArchiveFailureReason(workspaceArchiveRetries);
    this.engine.resolution.update(current,{cleanupReason,workspaceArchiveRetries},{},'workspace_cleanup_wait',`${id}: ${reason}; attempt ${attempts}; next retry ${nextAttemptAt}`);
  }
  /**
   * Reconcile recoverable nonterminal tasks and queue terminal archive work on
   * the engine's bounded cleanup lane. Archive work is durable through
   * `archiveIntentWorkspaceId`, so a restart resumes it without reopening or
   * repeating any delivery.
   */
  /**
   * A completed disposition is final. If a stale write reopened the task, restore the
   * terminal phase; the store writes the task's permanent outcome row on that transition.
   */
  private restoreDisposedTerminal(task:Task){
    if(task.removedAt||task.disposition?.status!=='complete'||['done','cancelled'].includes(task.phase))return false;
    this.engine.resolution.update(task,{attention:false,currentRunId:null,hostProcessSweep:task.resolution.hostProcessSweep??hostProcessSweepIntent('cancelled')},{phase:'cancelled',reason:task.disposition.reason||'Cancelled'},'terminal_phase_restored');
    return true;
  }
  async enqueuePass(scopedHost?: string){
    if(!scopedHost){
      const tasks=[...this.store.lifecycleTasks(true),...this.store.retirementTasks(),...this.store.finishedHookTasks(),...this.store.hostProcessSweepTasks()];
      for(const host of new Set(tasks.flatMap(task=>task.hostId?[task.hostId]:[])))
        await this.engine.withHost(host,()=>this.enqueuePass(host));
      return;
    }
    for(const task of this.store.lifecycleTasks(true)){
      if(task.hostId!==scopedHost)continue;
      if(!this.engine.taskHostAvailable(task))continue;
      if(this.restoreDisposedTerminal(task))continue;
      if(isDispositionActive(task))continue;
      if(['done','cancelled'].includes(task.phase))this.engine.settleTerminalIntentRuns(task.id);
      if(this.paused())return;
      // Queue #342: a terminal task's run-bound records settle in its task lane, never beside its archive lane.
      if(['done','cancelled'].includes(task.phase)&&(task.resolution.buildOutputCleanups.some(record=>record.runId&&(record.state==='intent'||record.state==='uncertain'))
        || task.resolution.workspaceRetirement && ['authorized','intent','uncertain'].includes(task.resolution.workspaceRetirement.state)))
        void this.engine.scheduleRunBuildOutputs(task.id).catch(error=>this.store.event(task.id,'run_build_output_warning',`Run build output settlement could not run: ${error instanceof Error?error.message:String(error)}`));
      if(task.phase==='done')this.engine.enqueueCleanup(task.id);
      else {
        // A recorded intent keeps the ordinary lane schedule until it is observed.
        // Its own retry interval decides whether this pass is due, so an unchanged
        // refusal is not re-proved on every sweep.
        const runs=this.store.runs(task.id);
        const unreadable=archiveIntentUnreadable(task,runs);
        const unreadableRetry=unreadable?task.resolution.workspaceArchiveRetries.find(record=>record.workspaceId===unreadable):undefined;
        const outstanding=archiveIntentOutstanding(task)
          ? task.resolution.workspaceArchiveRetries.find(record=>record.workspaceId===task.resolution.archiveIntentWorkspaceId):undefined;
        const observationDue=archiveIntentOutstanding(task)&&!(outstanding&&Date.parse(outstanding.nextAttemptAt)>Date.now());
        // A cancelled task's stale episode is settled on the ordinary cleanup lane, so
        // the settlement needs no run and the pass that closes it ends the schedule.
        const staleEpisode=task.phase==='cancelled'&&task.resolution.recoveryActive&&!runs.some(run=>run.role==='recovery'&&!run.released);
        if(staleEpisode || observationDue
          || Boolean(unreadable&&!(unreadableRetry&&Date.parse(unreadableRetry.nextAttemptAt)>Date.now())))this.engine.enqueueCleanup(task.id);
        try{
          await this.renewStaleCloseoutBase(task);
          await this.renewConsumerBlockedCloseout(task);
          await this.recover(task);
        }catch(error){
          if(isTransportFailure(error))this.engine.resolution.transportDeferred(task,error);
          else if(error instanceof LoginSessionFaultError||isLoginSessionFault(error))this.engine.resolution.environmentDeferred(task,error);
          else this.engine.resolution.attention(task,error instanceof Error?error.message:String(error));
        }
      }
    }
    // Runtime retirement proofs are owed by tasks whose workspaces are already
    // archived, so they are no longer lifecycle candidates. Drive the durable
    // backoff retry on its own lane; the record itself is the restart authority.
    for (const task of this.store.retirementTasks()) if (task.hostId===scopedHost && this.engine.taskHostAvailable(task)) this.engine.scheduleRetirement(task.id);
    // A completed cancellation is excluded from `lifecycleTasks`, so its
    // advisory finished-task stop is driven from its own durable intent: a crash
    // after the terminal transition resumes the same evaluation and reconciles a
    // running occurrence rather than leaving it forever.
    if (this.paused()) return;
    for (const task of this.store.finishedHookTasks()) {
      if (task.hostId !== scopedHost) continue;
      if (!this.engine.taskHostAvailable(task)) continue;
      try { await this.engine.hooks.finished(this.store.task(task.id)); }
      catch (error) { this.store.event(task.id, 'finished_hook_warning', `task.finished could not run: ${error instanceof Error ? error.message : String(error)}`); }
    }
    for (const task of this.store.hostProcessSweepTasks()) {
      if (task.hostId !== scopedHost) continue;
      if (!this.engine.taskHostAvailable(task)) continue;
      try { await this.engine.hooks.finished(this.store.task(task.id)); }
      catch (error) { this.store.event(task.id, 'finished_hook_warning', `task.finished could not run: ${error instanceof Error ? error.message : String(error)}`); }
      try { await sweepTaskHostProcesses(this.store, this.store.task(task.id)); }
      catch (error) { this.store.event(task.id, 'host_process_sweep_warning', `Host process sweep could not run: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  /** Direct pass: reconcile recoverable tasks, then await the serial cleanup drain. */
  async pass(){await this.enqueuePass();await this.engine.drainCleanup();}
}
