import { historicalWireLabel } from "../../shared/wire-labels";
import { settledThreadStatuses } from "../../shared/host";
import { existsSync, rmSync } from "node:fs";
import type { Run, Task } from "../../shared/contracts";
import type { AgentObservation } from "../host/adapter";
import type { WorkspaceContinuationHost } from "./workspace-continuation";
import type { TimelinePage } from "../recovery/stall";
import { readToolTimeline, liveToolIssue } from "../recovery/stall";
import { verifyReviewSourceView } from "../review/review-source";
import { verifyRecordedOrigin, verifyReportOnlyIdentity, originBranchContaining, git, queueCheckoutStatus } from "../git/index";
import { removeOwnedWorktree, repoCommonDir } from "./workspace-allocation";
import { removeBuildOutput, type BuildOutputCleanupHooks } from "./worktree-cleanup";
import { assertCanonicalOwnedPath, classifyOrphanWorktree, normalizeOwnedDirectoryPermissions, type WorkspaceDiscard } from "./orphan-worktree";
import { externalWorkspaceArchivePlacement, type ExternalWorkspaceCatalogView } from "./external-workspace-placement";

export class OwnedWorkspaceArchive {
  constructor(private readonly host: OwnedWorkspaceArchiveHost) {}
  async archiveTaskWorkspace(task:Task,id:string,directory:string,expectedHead:string,allowed:()=>boolean,uncertain:boolean,requirePublished=false,attachedAgentIds:ReadonlySet<string>=new Set(),requireDirectory=false,allowIdleForeignThreads=false,buildOutputCleanup?:BuildOutputCleanupHooks,reviewRun?:Run,discard?:WorkspaceDiscard|null,primaryArchived?:()=>boolean) {
    const workspace=this.host.workspaceHost.workspaceRef(id);
    const proofOnlyDone=Boolean(task.phase==='done'&&task.entrypoint==='proof'&&task.proofOnly&&task.proofOnlyResult
      &&task.proofOnlyResult.commit===task.proofOnly.commit);
    // A proof-only checkout is detached at its commit with no branch, however the task
    // ended, including an owner's acceptance of an interrupted run (effigy#666).
    const proofOnlyCheckout=Boolean(task.phase==='done'&&task.entrypoint==='proof'&&task.proofOnly);
    if(proofOnlyCheckout&&id===task.workspaceId&&expectedHead!==task.proofOnly!.commit)
      throw Error('Preserving proof-only workspace with a head other than its immutable qualification commit');
    // Papercut c7643943: an owner discard waives only the content proofs (clean
    // head, porcelain, publication). Identity, custody and every fence stay;
    // a worktree Git no longer knows is retired only through the positive
    // orphan classification below, for the task's own Queue-owned path.
    const discarding=Boolean(discard&&discard.workspaceId===id&&discard.directory===directory);
    const orphanOf=async()=>discarding&&id===task.workspaceId&&!reviewRun
      ?this.host.classifyOrphan({directory,repoPath:task.repoPath,dataDir:await this.host.ownedDataDirFor(task,directory) ?? this.host.dataDir(),taskId:task.id,continuing:task.resolution.archiveIntentWorkspaceId===id})
      :{orphaned:false as const};
    // The thread inventory narrows to the workspace's project only under a
    // binding read from this attempt's first, catalogued pass. Paseo fixes a
    // workspace's projectId at creation and refuses same-id recreation, and its
    // agent filter matches that id; a blank key widens and a wrong key empties
    // silently, so anything else, or any later contradiction, scans daemon-wide
    // for the rest of the attempt.
    let projectBinding:string|null|undefined;
    const prove=async(localTeardown:boolean)=>{
      await workspace.refresh();const current=workspace.current();
      const observedProject=current&&typeof current.projectId==='string'&&/^prj_[A-Za-z0-9]+$/.test(current.projectId)?current.projectId:null;
      if(projectBinding===undefined)projectBinding=observedProject;
      else if(current&&projectBinding!==observedProject)projectBinding=null;
      if(!current&&!existsSync(directory))return null;
      if(reviewRun){
        if(reviewRun.workspaceId!==id||reviewRun.reviewSourceView?.directory!==directory||!reviewRun.released)throw Error('Preserving unbound or live review view');
        await verifyReviewSourceView(task,reviewRun,primaryArchived,this.host.workspaceHost.workspaceIdAccepted?.bind(this.host.workspaceHost));
      }
      const slug=reviewRun?.reviewSourceView?.branch??(id===task.workspaceId?task.branch:`ns-closeout-${task.id}`);
      const intakeOwned=id===task.workspaceId&&task.reviewEntry?.preserveWorkspace===false&&task.reviewEntry.workspaceId===id;
      const rootOk=current?.projectRootPath===task.repoPath||current?.projectRootPath===directory;
      // Queue allocates the initial checkout by Git and registers it as a
      // directory workspace under the repository's canonical project, so its
      // descriptor carries no worktreeSlug: ownership follows the real bound
      // workspace, the canonical repository and the exact Queue-owned checkout
      // path, never presentation metadata. The same proof gates non-force
      // teardown below.
      let ownedCheckout=false;
      ownedCheckout=Boolean(await this.host.ownedDataDirFor(task,directory));
      const slugOk=intakeOwned||current?.worktreeSlug===slug||(!current?.worktreeSlug&&(current?.projectRootPath===directory||ownedCheckout));
      if(!current){
        // Catalog absence is only an observation. The retained binding, canonical
        // allocation and published source still supply the authority to tear down.
        if(!ownedCheckout||id!==task.workspaceId||task.directory!==directory||task.reviewEntry||!requirePublished)
          throw Error(`worktree.teardown failed: worktree directory remains after archive: ${directory}`);
      }else if(!rootOk||!slugOk||workspace.directory!==directory)throw Error('Preserving workspace: ownership or directory changed');
      if(uncertain&&current)throw Error('Workspace archive outcome is uncertain; inspect before retrying');
      if(!existsSync(directory)){
        if(requireDirectory)throw Error('Preserving workspace with missing directory');
        return null;
      }
      const entries:Awaited<ReturnType<typeof this.host.workspaceHost.archiveThreadPage>>["entries"]=[];
      let cursor:string|undefined;
      const cursors=new Set<string>();
      // The SDK has no workspace filter; labels would omit foreign threads.
      // Archive history can exceed any fixed page count. Require forward cursor
      // progress until the provider positively ends the list.
      const projectKeys=projectBinding?[projectBinding]:undefined,includeArchived=localTeardown||!current;
      for(;;){
        const result=await this.host.workspaceHost.archiveThreadPage({filter:{includeArchived,...(projectKeys?{projectKeys}:{})},page:{limit:200,cursor}});
        entries.push(...result.entries.filter(e=>e.agent.workspaceId===id));
        if(result.pageInfo.hasMore===false)break;
        const next=result.pageInfo.nextCursor;
        if(result.pageInfo.hasMore!==true||!next||cursors.has(next))throw Error('Workspace thread inventory is incomplete');
        cursors.add(next);cursor=next;
      }
      const foreignAgentIds:string[]=[];
      for(const entry of entries){
        const agent=entry.agent;
        if(historicalWireLabel(agent.labels, 'task')!==task.id&&!attachedAgentIds.has(agent.id)){
          if(!allowIdleForeignThreads)throw Error('Preserving workspace containing an unrelated thread');
          if(agent.id)foreignAgentIds.push(agent.id);
        }
        if(agent.activeTurn||agent.pendingPermissions?.length||!settledThreadStatuses.includes(agent.status??''))throw Error('Waiting for workspace threads to become idle');
      }
      // A released pinned view is Queue-owned scratch whose declared participants
      // must still be idle and free of a live owned tool before its checkout goes,
      // exactly like a Queue-owned task checkout: catalog membership alone does
      // not prove that no reader or helper still holds it.
      if(localTeardown||!current||ownedCheckout||reviewRun){
        for(const agentId of new Set([...attachedAgentIds,...entries.map(entry=>entry.agent.id)])){
          const state=await this.host.observe(agentId);
          if(!state||state.id!==agentId)throw Error('Preserving workspace: participant observation is unreadable');
          if(state.workspaceId!==id){
            if(entries.some(entry=>entry.agent.id===agentId)||(id===task.workspaceId&&agentId===task.agentId))throw Error('Preserving workspace: participant ownership changed');
            continue; // Attached task roles can belong to a separate review/closeout workspace.
          }
          // Corroboration only: a narrowed inventory that includes archived
          // threads must hold every participant this pass observes in the workspace.
          if(projectKeys&&includeArchived&&!entries.some(entry=>entry.agent.id===agentId))throw Error('Workspace thread inventory is incomplete');
          if(state.active||state.activeTurnId||state.permissions||!settledThreadStatuses.includes(state.status))throw Error('Waiting for workspace participants to become idle');
          // Native closed means session shutdown succeeded. Historical tool labels
          // cannot establish current managed liveness after that terminal boundary.
          if(state.status==='closed'||state.status==='gone')continue;
          // Once a task is merged it is free to archive (Tom, 2026-10-19): its
          // threads are owed nothing, so a stray running tool label on an idle
          // participant no longer preserves the workspace.
          if(task.phase==='done'&&(task.resolution.mergedCommit||proofOnlyDone))continue;
          const read=await readToolTimeline(this.host,agentId);
          // The participant observation above also proves no turn is live, so a
          // running call of a turn-bound kind is settled before its checkout goes.
          const issue='issue' in read?read.issue:liveToolIssue(read.entries,state);
          if(issue)throw Error(`Preserving workspace: owned tool evidence: ${issue}`);
        }
      }
      const orphan=await orphanOf();
      const actualHead=orphan.orphaned?null:await git(directory,'rev-parse','HEAD');
      if(!discarding&&(expectedHead&&actualHead!==expectedHead||await queueCheckoutStatus(directory,'status','--porcelain')))throw Error('Preserving workspace with uncommitted files or unexpected commits');
      // A report-only task's own workspace proves its registered worktree identity
      // on every pass, whatever its head (review #595: the retired base-equality
      // proof also carried this check).
      const reportOnly=!proofOnlyCheckout&&id===task.workspaceId&&task.phase==='done'&&Boolean(task.reportAcceptance)&&!task.prUrl&&!task.prHead&&!task.resolution.mergedCommit&&!task.resolution.syncedCommit;
      // Under a discard, report-only identity is still proved (root, common
      // dir, origin, branch); only its clean-state content proof is waived. An
      // orphan has no Git identity to read: its identity is the owned path.
      if(reportOnly&&!orphan.orphaned)await verifyReportOnlyIdentity(task,{allowDirty:discarding});
      // Publication is proved against the origin of this pass, which must name
      // the recorded repository; every later pass must see the same origin.
      const origin=requirePublished&&!discarding?await git(directory,'remote','get-url','origin'):'';
      let publication='';
      if(requirePublished&&!discarding){
        // Every publication path reads the recorded canonical origin, not only
        // report-only source: a foreign origin's branch proves nothing (review #538).
        await verifyRecordedOrigin(task,directory);
        const publishedBranch=reviewRun?task.branch:id===task.workspaceId?(task.branch||task.baseBranch):task.baseBranch;
        const listed=(await git(directory,'ls-remote','origin',`refs/heads/${publishedBranch}`)).split(/\s+/)[0]??'';
        let published=false;
        if(/^[a-f0-9]{40}$/.test(listed)){
          await git(directory,'fetch','--no-tags','--no-write-fetch-head','--refmap=','origin',`refs/heads/${publishedBranch}`);
          const current=(await git(directory,'ls-remote','origin',`refs/heads/${publishedBranch}`)).split(/\s+/)[0]??'';
          published=current===listed&&await git(directory,'merge-base','--is-ancestor',actualHead!,listed).then(()=>true,()=>false);
        }
        // A completed merge may have deleted the task branch. Its exact accepted
        // PR head is still safely published when the recorded merge commit is on
        // the pushed integration branch.
        if(!published&&id===task.workspaceId&&task.phase==='done'&&task.prHead===actualHead&&task.resolution.mergedCommit){
          const integration=(await git(directory,'ls-remote','origin',`refs/heads/${task.baseBranch}`)).split(/\s+/)[0]??'';
          if(/^[a-f0-9]{40}$/.test(integration)){
            await git(directory,'fetch','--no-tags','--no-write-fetch-head','--refmap=','origin',`refs/heads/${task.baseBranch}`);
            const current=(await git(directory,'ls-remote','origin',`refs/heads/${task.baseBranch}`)).split(/\s+/)[0]??'';
            published=current===integration&&await git(directory,'merge-base','--is-ancestor',task.resolution.mergedCommit,integration).then(()=>true,()=>false);
          }
        }
        if(!published){
          // A missing or behind task branch is not evidence of unpublished source:
          // the exact head on any branch the canonical origin advertises now is
          // published. Every pass reproves it and must select the same branch.
          // A report-only checkout still at its planning base is no exception:
          // once the base branch moves on, that base is an ancestor of it, and a
          // base rewritten away is on no advertised branch (consumer #689, 2026-10-22).
          const containing=await originBranchContaining(directory,actualHead!,[publishedBranch,task.baseBranch]);
          if(containing){published=true;publication=`origin/${containing}`;}
        }
        if(!published)throw Error(`Preserving workspace with unpublished commits on ${publishedBranch}`);
      }
      const expectedBranch=id===task.workspaceId?task.branch:slug;
      // An orphaned worktree has no Git identity to read; its identity is the
      // durable binding and exact owned path proved above, branch unproven.
      if(!orphan.orphaned&&(await git(directory,'branch','--show-current')!==expectedBranch||await git(directory,'rev-parse','--path-format=absolute','--git-common-dir')!==await git(task.repoPath,'rev-parse','--path-format=absolute','--git-common-dir')))throw Error('Preserving workspace: Git ownership changed');
      if(!discarding&&(await git(directory,'rev-parse','HEAD')!==actualHead||await queueCheckoutStatus(directory,'status','--porcelain')))throw Error('Preserving workspace with uncommitted files or unexpected commits before teardown');
      return {foreignAgentIds,actualHead,origin,publication,current,orphan};
    };
    const initial=await prove(false);
    if(!initial)return [];
    if(buildOutputCleanup){
      try{
        const cleanup=buildOutputCleanup.begin();
        if(cleanup===false)return false;
        if(cleanup==='run'){
          const placement=this.host.placement();
          if(id===task.workspaceId&&placement&&directory===await this.host.ownedPathFor(task))placement.admit(directory);
          const result=await removeBuildOutput(directory);
          buildOutputCleanup.observed(result);
          if(!result.safe)return false;
        }
      }catch(error){
        const reason=error instanceof Error?error.message:String(error);
        buildOutputCleanup.uncertain(reason);
        throw error;
      }
    }
    const prepared=await prove(false);
    if(!prepared)return initial.foreignAgentIds;
    if(prepared.actualHead!==initial.actualHead)throw Error('Preserving workspace with unexpected commits before archive');
    if(prepared.orphan.orphaned!==initial.orphan.orphaned)throw Error('Preserving workspace: its Git state changed before archive');
    if(prepared.origin!==initial.origin)throw Error('Preserving workspace: repository origin changed before archive');
    if(prepared.publication!==initial.publication)throw Error('Preserving workspace: publication evidence changed before archive');
    if(prepared.current){
      if(!allowed())return false;
      let result:Awaited<ReturnType<typeof workspace.archive>>;
      try{result=await workspace.archive(`ns-archive-${task.id}-${id}`);}
      catch(error){throw Error(`Paseo workspace.archive failed: ${error instanceof Error?error.message:String(error)}`);}
      if(result.error)throw Error(`Paseo workspace.archive failed: ${result.error}`);if(!result.archivedAt)throw Error('Paseo workspace.archive was not confirmed');
    }
    if(existsSync(directory)){
      // Observe again after native delivery/cleanup. Never replay native archive
      // to finish local teardown, and never reuse pre-await source/tool proofs.
      const fresh=await prove(true);
      if(!fresh)return initial.foreignAgentIds;
      if(fresh.current)throw Error('worktree.teardown failed: workspace remains catalogued; inspect before retrying');
      if(fresh.actualHead!==initial.actualHead)throw Error('Preserving workspace with unexpected commits before teardown');
      if(fresh.origin!==initial.origin)throw Error('Preserving workspace: repository origin changed before teardown');
      if(fresh.publication!==initial.publication)throw Error('Preserving workspace: publication evidence changed before teardown');
      await workspace.refresh();
      if(workspace.current())throw Error('Preserving workspace: catalog ownership changed before teardown');
      if(fresh.orphan.orphaned!==initial.orphan.orphaned)throw Error('Preserving workspace: its Git state changed before teardown');
      const ownedData=await this.host.ownedDataDirFor(task,directory);
      if(!ownedData)throw Error('Preserving workspace: source or ownership changed before teardown');
      if(!initial.orphan.orphaned&&(await git(directory,'rev-parse','--path-format=absolute','--git-common-dir')!==await repoCommonDir(task.repoPath)
        ||await git(directory,'branch','--show-current')!==task.branch
        ||!discarding&&(await git(directory,'rev-parse','HEAD')!==initial.actualHead||await queueCheckoutStatus(directory,'status','--porcelain'))))throw Error('Preserving workspace: source or ownership changed before teardown');
      if(initial.origin&&await git(directory,'remote','get-url','origin')!==initial.origin)throw Error('Preserving workspace: repository origin changed before teardown');
      try{
        const commonDir=await repoCommonDir(task.repoPath);
        // Git has no record of an orphaned worktree, so `worktree remove`
        // cannot apply: re-prove the orphan, then the fences, then the
        // canonical path synchronously, and delete exactly the owned directory.
        // Links inside are removed, never followed.
        if(initial.orphan.orphaned&&!(await this.host.classifyOrphan({directory,repoPath:task.repoPath,dataDir:ownedData,taskId:task.id,continuing:task.resolution.archiveIntentWorkspaceId===id})).orphaned)
          throw Error('the worktree is no longer orphaned');
        if(!allowed())return false;
        // Under the discard, the canonical path is re-proved and read-only
        // directories inside it are opened for removal, synchronously, with no
        // await before the removal. A normalization failure stops removal.
        if(discarding){assertCanonicalOwnedPath(directory,ownedData,commonDir,task.id);normalizeOwnedDirectoryPermissions(directory);}
        if(initial.orphan.orphaned)rmSync(directory,{recursive:true});
        else await removeOwnedWorktree(task.repoPath,directory,discarding);
      }
      catch(error){throw Error(`worktree.teardown failed: ${error instanceof Error?error.message:String(error)}`);}
      if(existsSync(directory))throw Error(`worktree.teardown failed: Queue-owned worktree directory remains after archive: ${directory}`);
    }
    return initial.foreignAgentIds;
  }
}

export interface ArchiveThreadRecord { id: string; workspaceId?: string | null; labels?: Record<string, string>; activeTurn?: unknown; pendingPermissions?: readonly unknown[] | null; status?: string | null; archivedAt?: string | null }
export interface ArchiveThreadPage { entries: { agent: ArchiveThreadRecord }[]; pageInfo: { hasMore: boolean; nextCursor?: string | null } }
export interface OwnedWorkspaceArchiveHost extends WorkspaceContinuationHost {
  readonly workspaceHost: WorkspaceContinuationHost["workspaceHost"] & { workspaceIdAccepted?(id: unknown): boolean; archiveThreadPage(options: { filter: { includeArchived: boolean; projectKeys?: string[] }; page: { limit: number; cursor?: string } }): Promise<ArchiveThreadPage> };
  observe(id: string): Promise<AgentObservation | null>;
  agentTimelinePage?(id: string, limit?: number): Promise<TimelinePage | null>;
  classifyOrphan: typeof classifyOrphanWorktree;
  ownedDataDirFor(task: Task, directory: string): Promise<string | null>;
  dataDir(): string;
}
