import type { LaunchSourceContext } from '../launch';
import type { LaunchMachinePorts } from './machine';
import { git } from '../../git/index';
import { readGitCheckout } from '../../git/git-identity';
import { proveReviewRunSource } from '../../review/ordinary-review';
import { chooseProfile, reviewerFiltersWorker } from '../routing';
import { OPERATOR_WORKER_REMAP_REASON, proofExecutor } from '../../recovery/task-reasons';
import { retainedProgressRun } from '../retained-work';
import { assertCanonicalPrSource, evidenceOnlyPr, taskPrNumber } from '../../forge/index';
import { verifyProofSource } from '../../qa/proof-execution';
import { groupIsUnavailable, supersedingRouteProfile } from '../../../shared/pool';
import { RETAINED_WORKER_PROFILE_REASON, workerProfileIsExcluded, type Profile, type Run, type Task } from '../../../shared/contracts';
import type { ProofActivation } from '../../resolution';

/** Keep the retained worker, wait for a first independent one, or honour a superseding route. */
export type RevisionRunPlan = 'fresh' | 'wait' | 'attention' | 'reselect' | 'keep' | 'continue';
export type RevisionRunFacts = {
  firstReviewEntryWorker: boolean;
  firstWorkerSelected: boolean;
  revision: boolean;
  retainedProfileIssue: boolean;
  superseding: boolean;
  hasAgent: boolean;
  failoverArmed: boolean;
  replacementMatches: boolean;
};
/**
 * First review-entry revision picks an independent worker; later revisions keep
 * the retained route unless a required worker request supersedes it.
 */
export function revisionRunPlan(facts: RevisionRunFacts): RevisionRunPlan {
  if (facts.firstReviewEntryWorker) return facts.firstWorkerSelected ? 'fresh' : 'wait';
  if (!facts.revision) return 'continue';
  if (facts.retainedProfileIssue) return 'attention';
  if (facts.superseding && facts.hasAgent && !facts.failoverArmed && !facts.replacementMatches) return 'reselect';
  return 'keep';
}

/**
 * Prepare the source a run is launched from: the detached ordinary review's
 * custody, the first revision worker's independent profile, the retained worker
 * route, and the exact PR head the run may dispatch at.
 */
export class RunLaunchSource {
  constructor(readonly resolution: LaunchSourceContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  get machine(): LaunchMachinePorts { return this.adapter; }
  async prepareLaunchSource(t: Task, role: Run['role'], options: { profile?: Profile; instruction?: string; proof?: ProofActivation }):Promise<void> {
    if (t.directory && !t.reviewEntry && this.store.runs(t.id).some(run => run.ordinaryDetached) && readGitCheckout(t.directory).branch === '') {
      const previous = this.store.runs(t.id).findLast(run => run.ordinaryDetached);
      if (!previous?.released || !['finished', 'superseded'].includes(previous.status)) throw Error('Detached ordinary review is still owned');
      await this.resolution.ordinaryRoundCustody(t, previous, true);
      await proveReviewRunSource(t, previous.head, true);
      await git(t.directory, 'checkout', t.branch);
      await proveReviewRunSource(t, previous.head, false);
    }

    const firstReviewEntryWorker=role==='revision'&&t.entrypoint==='review'&&!t.agentId;
    let firstWorkerSelection:ReturnType<typeof chooseProfile>|null=null;
    if(firstReviewEntryWorker){
      const unavailable=new Set(this.store.db.prepare('SELECT data FROM availability').all().flatMap(row=>{const state=JSON.parse(String(row.data));return groupIsUnavailable(state)?[state.group as string]:[]}));
      const profiles=this.resolution.profiles().filter(profile=>!workerProfileIsExcluded(t,profile.id)&&profile.model!=='default'&&!reviewerFiltersWorker(t.resolution.reviewerProfile,profile));
      firstWorkerSelection=chooseProfile({...t,preferredProfileId:'',requirePreferred:false,thinkingOptionId:''},profiles,this.store.pool(),this.store.counts(),unavailable,'worker',this.store.recentCounts(),this.store.usageLevel(), this.store.demandRoleOffsets(), true);
      if(revisionRunPlan({ firstReviewEntryWorker: true, firstWorkerSelected: Boolean(firstWorkerSelection), revision: true, retainedProfileIssue: false, superseding: false, hasAgent: Boolean(t.agentId), failoverArmed: Boolean(t.failoverReason), replacementMatches: false }) === 'wait'){this.resolution.waiting(t,`No eligible first revision worker independent of the retained reviewer${this.resolution.usageCeilingNote(t,'worker',[],new Set(),()=>chooseProfile({...t,preferredProfileId:'',requirePreferred:false,thinkingOptionId:''},profiles,this.store.pool(),this.store.counts(),unavailable,'worker',this.store.recentCounts(),'maximum',this.store.demandRoleOffsets(), true))}`, 'route_unavailable');return;}
    }else if(role==='revision'){
      const issue=this.resolution.retainedWorkerProfileIssue(t);
      if(issue && revisionRunPlan({ firstReviewEntryWorker: false, firstWorkerSelected: false, revision: true, retainedProfileIssue: true, superseding: false, hasAgent: Boolean(t.agentId), failoverArmed: Boolean(t.failoverReason), replacementMatches: false }) === 'attention'){this.resolution.update(t,{currentRunId:null,attention:true,integrationTurn:null},{phase:'needs_attention',reason:`${RETAINED_WORKER_PROFILE_REASON}: ${issue}; remap with restart (an optional instruction becomes the replacement's continuation), choose the replacement with route role=worker, or change profile availability`},'needs_attention');return;}
      // Task 515: a recorded dispatch selection that predates the latest
      // required route for the worker yields to it. The retained agent cannot
      // change profile, so the approved route is armed for the existing
      // replacement machinery instead of launching another run on the stale
      // profile; an in-flight owner replacement keeps its own authority.
      const superseding = supersedingRouteProfile(t.profileRequests?.worker, t.profile?.id, this.store.pool(), this.store.usageLevel());
      if (superseding && revisionRunPlan({ firstReviewEntryWorker: false, firstWorkerSelected: false, revision: true, retainedProfileIssue: false, superseding: true, hasAgent: Boolean(t.agentId), failoverArmed: Boolean(t.failoverReason), replacementMatches: t.replacementProfile?.profileId === superseding }) === 'reselect') {
        const supersedingReason = (t.profileRequests?.worker?.reason ?? 'Operator-approved route').slice(0, 4000);
        t = this.resolution.update(t, {}, { failoverReason: `${OPERATOR_WORKER_REMAP_REASON}. ${supersedingReason}. Continue the existing task: ${this.resolution.workerContinuation(t)}`.slice(0, 2000),
          replacementProfile: { profileId: superseding, reason: supersedingReason } }, 'worker_route_honoured', superseding);
        return;
      }
    }
    const prePrWorkerResume=role==='revision'&&!t.completion?.prNumber&&!t.resumePrNumber;
    const repairingPrIdentity=role==='revision'&&t.resolution.revisionPrRepair;
    const resumingUnpublished=role==='revision'&&t.resolution.revisionResumeUnpublished;
    // Project-d #117 review: a revision that would bind an evidence-only PR
    // records the task version and runs its dispatch decision was made from,
    // before the verification awaits; the reservation reserves nothing if
    // either changed. A task already changed since that decision waits.
    const progress = role === 'revision' && !repairingPrIdentity ? retainedProgressRun(this.store,t) : null;
    const decided = role === 'revision' && !repairingPrIdentity && (evidenceOnlyPr(t) || progress) ? { version: t.version, runs: JSON.stringify(this.store.runs(t.id)) } : undefined;
    if (decided && this.store.task(t.id).version !== decided.version) return;
    // A revision returns the author to its own worktree. Its uncommitted work is what the
    // revision continues, so it needs PR identity and the continuation proof, not the
    // clean-worktree proof a review of an exact head requires.
    const revisionContinuation = role === 'revision' && !resumingUnpublished && Boolean(this.machine.verifyPrIdentity && this.machine.verifyResume);
    let pr = t.entrypoint === 'proof' ? null : role === 'closeout' || prePrWorkerResume || repairingPrIdentity ? null : resumingUnpublished || revisionContinuation ? await this.machine.verifyPrIdentity!(t,taskPrNumber(t),{allowDraft:true}) : await this.machine.verifyPr(t, taskPrNumber(t));
    if (revisionContinuation && pr) await this.machine.verifyResume!(t);
    let retainedPrePrHead: string | null = null;
    if (prePrWorkerResume) {
      if (!this.machine.verifyResume) throw new Error('Continuation worktree verification is unavailable');
      const verifiedHead = await this.machine.verifyResume(t);
      if (this.resolution.paused()) return;
      const latest = this.store.task(t.id);
      if (latest.phase !== t.phase || latest.resolution.currentRunId !== t.resolution.currentRunId ||
          latest.branch !== t.branch || latest.directory !== t.directory || latest.workspaceId !== t.workspaceId ||
          latest.planningBase !== t.planningBase || latest.planningCommit !== t.planningCommit)
        throw new Error('Task changed during pre-PR continuation verification');
      t = latest;
      retainedPrePrHead = verifiedHead ?? t.completion?.head ?? t.checkpoints.records.at(-1)?.head ?? t.planningBase;
    }
    if(resumingUnpublished){
      if(pr?.head!==t.prHead)throw Error('PR head changed before unpublished revision recovery');
      if(!this.machine.verifyResume)throw Error('Continuation worktree verification is unavailable');
      await this.machine.verifyResume(t);
    }
    // Project-d #117: a revision on a PR the task knows only from a reported
    // completion binds that PR, at the head just observed, in the reservation
    // that dispatches it; a changed task reserves nothing.
    let continuedPr = pr && role === 'revision' && !repairingPrIdentity && evidenceOnlyPr(t) ? this.resolution.continuedPrBinding(t, evidenceOnlyPr(t)!, pr, decided) : null;
    if (pr && progress && pr.head !== t.prHead && !continuedPr) {
      const wait=await this.resolution.continuedProgressWait(t,pr.head);
      if(wait){this.resolution.waiting(this.store.task(t.id),wait,'lifecycle');return;}
      assertCanonicalPrSource(pr,taskPrNumber(t));
      continuedPr = {number:taskPrNumber(t),url:pr.url,head:pr.head,priorHead:t.prHead,completionEventId:progress.completion!.eventId,
        progressRunId:progress.id,branch:t.branch,baseBranch:t.baseBranch,repoPath:t.repoPath,agentId:t.agentId,workspaceId:t.workspaceId,decided};
    }
    // Spec 057 (task 553): a null prHead with an authenticated worker report
    // naming the pushed head binds that head against the task's PR before
    // review, so the retained reviewer has a head to review.
    if (pr && role === 'reviewer' && !t.prHead && !continuedPr && this.resolution.bindReportedHeadForReview(t, pr)) {
      t = this.store.task(t.id);
    }
    if (pr && pr.head !== t.prHead && !continuedPr) {
      if (role !== 'revision') throw new Error('PR head changed; a new worker report and review are required');
      const revisions = this.store.runs(t.id).filter(run => run.role === 'revision');
      const latestResult = revisions.findLast(run => run.completion)?.completion;
      if (revisions.some(run => !run.released || ['intent','uncertain'].includes(run.status))
        || latestResult && ['blocked','error'].includes(latestResult.status)
        || t.completion?.runId === t.runId && ['blocked','error'].includes(t.completion.status)
        || Boolean(t.resumePrNumber && t.runId && (!t.completion || t.completion.runId !== t.runId) && !this.store.run(t.runId)))
        throw new Error('Retained progress cannot be bound without its authenticated released author report and source proof');
      t = this.store.update(t.id, { prHead: pr.head }, 'revision_head', pr.head);
    }
    // Task 405: the proof executor observes the exact published head after the
    // forge observation, before any thread is selected. The reservation re-checks
    // the same facts before it dispatches anything.
    if (proofExecutor(role)) {
      if (!pr && !t.proofOnly) throw new Error('An author-side proof execution needs the exact published pull request');
      const source = await verifyProofSource(t, t.proofOnly?.commit ?? pr!.head);
      if (!options.proof) throw new Error('Proof execution activation identity is missing');
      options = { ...options, proof: { ...options.proof, tree: source.tree } };
    }
    return await this.resolution.selectLaunchThread(t, role, options, {firstReviewEntryWorker, firstWorkerSelection, prePrWorkerResume, retainedPrePrHead, resumingUnpublished, continuedPr});
  }
}
