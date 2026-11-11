import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isDispositionActive, isDispositionComplete, mergeReviewEvidenceAt, type Incident, type OwnerAcceptanceRecord, type Run, type Task } from "../../shared/contracts";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { isLoginSessionFault, LoginSessionFaultError } from "../../shared/session-fault";
import { isTransportFailure } from "../../shared/transport";
import { escalationWaitDetail, findOpenPlannerEscalation, PLANNER_ESCALATION_CHOICES, type LadderEvent } from "../questions/blocker-ladder";
import { dispatchBlocked } from "../dispatch/capacity";
import { settleSupersededFencesInTx } from "../recovery/fence-settlement";
import { ForgeOutageError } from "../forge/forge-health";
import { git, gitAncestrySync, GitReadTimeoutError, queueCheckoutStatus } from "../git/index";
import { readGitCheckout } from "../git/git-identity";
import { incidentKey } from "../recovery/incident";
import { blockingRecoveryEffectsRefusal } from "../recovery/recovery-effects";
import type { ReviewEntryExternalMerge, RetainedSourceExternalMerge, Resolution } from "../resolution";
import type { VerifiedEnclosingOperation } from "../planning/enclosing-operation";
import { DurableFenceRefusal } from "../intake/run-settlement";
import { digest, now } from "../store/store";
import { ACCEPTED_PR_RECONCILIATION_REASON, EXTERNAL_MERGE_CHECK_REASON_PREFIX, EXTERNAL_MERGE_CHECK_RECOVERED_REASON, EXTERNAL_MERGE_PROBE_LIMIT, EXTERNAL_MERGE_PROBE_MS, mergedWithNonePatch } from "../recovery/task-reasons";

export type ExternalMergeContext = Pick<Resolution, 'adapter' | 'assignIntegrationTurn' | 'attention' | 'environmentDeferred' | 'executionLease' | 'gitTransientFailure' | 'hasEarlierIntegrationTurn' | 'host' | 'openPlannerEscalation' | 'paused' | 'resolveIncident' | 'reviewRequired' | 'store' | 'transportDeferred' | 'update' | 'waiting'> & {
  recovery: Pick<Resolution['recovery'], 'releaseWithNotAppliedAction' | 'settledEpisodeChanges'>;
};

/** Accepts or detects a PR merged outside Nucleus. */
export class ExternalMerge {
  constructor(readonly resolution: ExternalMergeContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  /**
   * The last automatic external-merge probe per task, with the lifecycle identity
   * it observed. In memory only: a restart forgets every stamp and therefore
   * probes immediately, which is the conservative direction.
   */
  private readonly externalMergeProbes = new Map<string, { at: number; identity: string }>();
  /** The window in which an unchanged task's automatic probe is not repeated. */
  externalMergeProbeMs = EXTERNAL_MERGE_PROBE_MS;

  /**
   * Operator-only: close out a PR merged outside Queue at a head that descends from the
   * recorded work (a planner commit on the task branch). The reason and both heads are
   * recorded; the merge then follows the normal external-merge closeout.
   *
   * Task 408: the same verb reconciles a queued review-entry task that never
   * dispatched (`reviewEntry` below). It has no runs to stop and no reviewer at
   * the head its own PR merged at, so the merge alone can never stand in for
   * review: the observed merged head and commit are proved, the exact-final-head
   * operator source acceptance is recorded beside them in the same transaction,
   * and the recorded source head (`prHead`), the immutable intake block, both
   * holds, pause, provenance and every declaration stay exact. Nothing is
   * dispatched, and no review, native proof or source-author credit is invented.
   */
  async acceptExternalMerge(t: Task, reason: string, settleFences?: string, appliedCoordinatorRunId?: string, reviewEntry?: ReviewEntryExternalMerge, retained?: RetainedSourceExternalMerge, enclosingOperation?:()=>VerifiedEnclosingOperation|undefined) {
    if (!this.adapter.externalMerge) throw new Error('External merge verification is unavailable');
    // A never-dispatched review-entry task is `queued` by definition, so the
    // dispatched-task refusal applies only when this boundary does not hold. The
    // boundary is the one the dependency correction reads; the authenticated
    // invocation executing this move is not a competing
    // writer (task 404), and every other unfinished operation still refuses.
    const enclosing = reviewEntry?.enclosing();
    const boundary = enclosing ? this.store.reviewEntryUnrunBeforeFirstRun(t, enclosing) : false;
    if (reviewEntry && !boundary) throw new Error('The review-entry pre-first-run boundary changed before the external merge; nothing was written');
    if ((!boundary && ['done','cancelled','queued'].includes(t.phase)) || t.resolution.mergeIntent || t.resolution.mergedCommit) throw new Error('Only an unmerged dispatched task can accept an external merge');
    const leases = () => this.store.runs(t.id).filter(r=>!r.released);
    const captured = leases();
    const allRunIdentity = JSON.stringify(this.store.runs(t.id));
    const stopped = async () => {
      for (const run of captured) {
        if (!run.agentId || !run.workspaceId || ['intent','uncertain'].includes(run.status)) throw Error('Unknown run delivery must be reconciled before accepting the external merge');
        if (!['revision','reviewer','executor'].includes(run.role)) continue;
        const state = await this.resolution.host.observe(run.agentId);
        if (state.id !== run.agentId || state.workspaceId !== run.workspaceId || state.active || state.activeTurnId || state.permissions || !['idle','error','closed'].includes(state.status))
          throw Error('A run still owns an active thread; stop it before accepting the external merge');
      }
    };
    // The never-dispatched boundary proves inactive ownership before it reads
    // the forge: an unknown writer is not an absent one.
    if (reviewEntry) await reviewEntry.assertQuiet();
    if (retained) { retained.assertState(); await retained.assertQuiet(); }
    if (!reviewEntry && !retained && !await this.resolution.executionLease(t,enclosingOperation?.())) {
      const effects=blockingRecoveryEffectsRefusal(this.store,this.store.task(t.id),{enclosing:enclosingOperation?.(),noticeKinds:'all'});
      throw new DurableFenceRefusal(`Task execution participants or effects are not settled${effects?`: ${effects}`:''}`);
    }
    await stopped();
    const sourceWitness = retained ? await this.proveRetainedExternalMergeSource(t) : null;
    const result = await this.adapter.externalMerge(t, true, Boolean(retained));
    if (!result) throw new Error('The task PR is not merged');
    if (reviewEntry) return this.acceptReviewEntryExternalMerge(t, reason, settleFences, appliedCoordinatorRunId, reviewEntry, captured, allRunIdentity, leases, stopped, result);
    if (retained) return this.acceptRetainedExternalMerge(t, reason, settleFences, appliedCoordinatorRunId, retained, captured, allRunIdentity, leases, stopped, result, sourceWitness!);
    return this.acceptOrdinaryExternalMerge(t, reason, settleFences, appliedCoordinatorRunId, enclosingOperation, captured, allRunIdentity, leases, stopped, result);
  }
  /** Review-entry job of acceptExternalMerge: ancestry, then workspace, then the shared settlement. */
  private async acceptReviewEntryExternalMerge(t: Task, reason: string, settleFences: string | undefined, appliedCoordinatorRunId: string | undefined, reviewEntry: ReviewEntryExternalMerge, captured: Run[], allRunIdentity: string, leases: () => Run[], stopped: () => Promise<void>, result: {head:string;commit:string}) {
    // A positively observed merge names both exact identities; never a
    // caller-supplied head and never a guessed commit.
    if (!/^[a-f0-9]{40}$/.test(String(result.head)) || !/^[a-f0-9]{40}$/.test(String(result.commit)))
      throw Error('The observed external merge did not name an exact merged head and commit');
    const intake = t.reviewEntry?.verifiedHead, recorded = t.prHead;
    if (!t.directory || !intake || !recorded || !/^[a-f0-9]{40}$/.test(intake) || !/^[a-f0-9]{40}$/.test(recorded))
      throw Error('Reconciling a never-dispatched external merge requires the bound external workspace and the recorded intake and source heads');
    // The merged head must descend from the immutable intake head AND the
    // task's latest recorded head: a rewritten or unrelated source is never
    // adopted as this task's work.
    for (const ancestor of [...new Set([intake, recorded])]) {
      try { await git(t.directory, 'merge-base', '--is-ancestor', ancestor, result.head); }
      catch { throw Error(`The observed merged head ${result.head} does not descend from the recorded source head ${ancestor}; this task's work was not merged at that head`); }
    }
    await stopped();
    // Fresh inactive ownership after every await, then the workspace witness
    // synchronously before the commit: a moved, dirty or aliased checkout
    // refuses with nothing written, and no writer is read as absent.
    await reviewEntry.assertQuiet();
    if (await queueCheckoutStatus(t.directory!, 'status', '--porcelain')) throw Error('The bound external workspace is dirty; the external merge proof is stale');
    if (readGitCheckout(t.directory!).head !== result.head) throw Error('The bound external workspace moved during the external merge proof; nothing was accepted');
    return this.settleAcceptedExternalMerge(t, reason, settleFences, appliedCoordinatorRunId, reviewEntry, undefined, captured, allRunIdentity, leases, result, null);
  }
  /** Retained-source job of acceptExternalMerge: descendant-head proof, then the shared settlement. */
  private async acceptRetainedExternalMerge(t: Task, reason: string, settleFences: string | undefined, appliedCoordinatorRunId: string | undefined, retained: RetainedSourceExternalMerge, captured: Run[], allRunIdentity: string, leases: () => Run[], stopped: () => Promise<void>, result: {head:string;commit:string}, sourceWitness: string) {
    await stopped();
    if (!/^[a-f0-9]{40}$/.test(result.head) || !/^[a-f0-9]{40}$/.test(result.commit)) throw Error('External merge identity is incomplete');
    if (result.head === sourceWitness) throw Error('A retained-source acceptance requires a descendant final head');
    retained.acceptanceFor(result.head);
    await retained.assertQuiet();
    retained.assertState();
    if (await this.proveRetainedExternalMergeSource(t) !== sourceWitness) throw Error('Retained task source changed during external merge proof');
    if (gitAncestrySync(t.directory!, sourceWitness, result.head) !== 'ancestor') throw Error('Merged head does not descend from the retained source or ancestry is unreadable');
    return this.settleAcceptedExternalMerge(t, reason, settleFences, appliedCoordinatorRunId, undefined, retained, captured, allRunIdentity, leases, result, sourceWitness);
  }
  /** Ordinary job of acceptExternalMerge: re-lease, then the shared settlement. */
  private async acceptOrdinaryExternalMerge(t: Task, reason: string, settleFences: string | undefined, appliedCoordinatorRunId: string | undefined, enclosingOperation: (()=>VerifiedEnclosingOperation|undefined) | undefined, captured: Run[], allRunIdentity: string, leases: () => Run[], stopped: () => Promise<void>, result: {head:string;commit:string}) {
    await stopped();
    if (!await this.resolution.executionLease(t,enclosingOperation?.())) {
      const effects=blockingRecoveryEffectsRefusal(this.store,this.store.task(t.id),{enclosing:enclosingOperation?.(),noticeKinds:'all'});
      throw new DurableFenceRefusal(`Task execution participants or effects changed during external merge proof${effects?`: ${effects}`:''}`);
    }
    return this.settleAcceptedExternalMerge(t, reason, settleFences, appliedCoordinatorRunId, undefined, undefined, captured, allRunIdentity, leases, result, null);
  }
  /** One transaction: run release, the job's acceptance, and the observed merge. */
  private settleAcceptedExternalMerge(t: Task, reason: string, settleFences: string | undefined, appliedCoordinatorRunId: string | undefined, reviewEntry: ReviewEntryExternalMerge | undefined, retained: RetainedSourceExternalMerge | undefined, captured: Run[], allRunIdentity: string, leases: () => Run[], result: {head:string;commit:string}, sourceWitness: string | null) {
    return this.store.transaction(()=>{
      const current = this.store.task(t.id);
      if (current.version !== t.version || JSON.stringify(this.store.runs(t.id)) !== allRunIdentity) throw new Error('Task or run changed during external merge verification');
      let acceptance: OwnerAcceptanceRecord | null = null;
      if (retained) {
        retained.assertState();
        if (this.retainedExternalMergeIdentity(current) !== sourceWitness || gitAncestrySync(current.directory!, sourceWitness!, result.head) !== 'ancestor')
          throw Error('Retained source or ancestry changed before external merge settlement');
        acceptance = retained.acceptanceFor(result.head);
        if (acceptance.head !== result.head || acceptance.kind !== 'operator_source' || acceptance.review !== null)
          throw Error('The exact-final-head operator source acceptance changed');
        this.store.event(t.id, 'owner_acceptance', JSON.stringify({taskId:t.id,...acceptance}).slice(0,4000));
      }
      if (reviewEntry) {
        // Re-proved inside the commit: the boundary, the recorded merge and the
        // authenticated invocation that is executing it. An unverifiable
        // invocation exempts nothing.
        const invoking = reviewEntry.enclosing();
        if (current.resolution.mergeIntent || current.resolution.mergedCommit || !invoking
          || !this.store.reviewEntryUnrunBeforeFirstRun(current, invoking))
          throw new Error('The review-entry boundary or recorded merge changed during the external merge proof; nothing was written');
        const derived = reviewEntry.acceptanceFor(result.head);
        // The acceptance binds the OBSERVED merged head, never the recorded
        // source head and never a previous head's ruling.
        if (derived.head !== result.head || derived.kind !== 'operator_source' || derived.review !== null)
          throw new Error('The exact-final-head operator source acceptance does not bind the observed merged head');
        acceptance = derived;
        this.store.event(t.id, 'owner_acceptance', JSON.stringify({ taskId: t.id, kind: acceptance.kind, prNumber: acceptance.prNumber,
          head: acceptance.head, missingEvidence: acceptance.missingEvidence, review: acceptance.review, actor: acceptance.actor,
          authority: acceptance.authority, reason: acceptance.reason, qualification: acceptance.qualification }).slice(0, 4000));
      }
      for (const run of leases()) {
        // Spec 050 (#3569): a recovery run released at closeout still records a
        // pending accepted action as not applied instead of closing silently.
        if (run.role === 'recovery' && this.resolution.recovery.releaseWithNotAppliedAction(current, run, `accepted external merge: ${reason}`, appliedCoordinatorRunId)) continue;
        this.store.putRun({...run,released:true,active:false,status:run.completion?'finished':'superseded'});
      }
      if(captured.length)this.store.event(t.id,'external_merge_stopped_runs_settled',captured.map(r=>r.id).join(', '));
      this.store.event(t.id, 'external_merge_head_accepted', `${t.prHead ?? 'none'} -> ${result.head} at ${result.commit}: ${reason}`.slice(0, 2000));
      const latest = this.resolution.assignIntegrationTurn(current);
      const holding = !this.resolution.hasEarlierIntegrationTurn(latest);
      // A never-dispatched task keeps its recorded source head: the merged head
      // and commit are recorded beside it, not over it.
      const headPatch = acceptance ? {} : { prHead: result.head };
      // Every unreleased run is released above, so an episode one of them held
      // closes here: the merge is the outcome its coordinator was recovering toward (Queue #680).
      const episodeDetail = `External merge observed: ${reason}`;
      const episode = this.resolution.recovery.settledEpisodeChanges(latest, episodeDetail);
      const updated=this.resolution.update(latest,{externalMerge:true,mergeHead:result.head,mergedCommit:result.commit,currentRunId:null,attention:false,externalMergePreAttention:null,
        ...(acceptance?{}:mergedWithNonePatch(latest,result.head)),
        ...(acceptance?{ownerAcceptances:[...(latest.resolution.ownerAcceptances??[]),acceptance]}:{}),
        ...(episode??{})},holding
        ? {phase:'syncing',...headPatch,coordinatorGeneration:latest.coordinatorGeneration+1,reason:acceptance?'Exact-final-head operator source acceptance recorded; the external merge is observed and main synchronizes before closeout':'Operator accepted the external merge; synchronizing main before coordinator closeout'}
        : {phase:'merging',...headPatch,reason:acceptance?'Exact-final-head operator source acceptance recorded; the external merge is observed and waits for the repository integration turn':'Operator accepted the external merge; waiting for repository integration turn'},'external_merge_observed');
      if (episode) this.store.event(t.id, 'recovery_episode_settled', episodeDetail);
      // Spec 050 atomic verbs: the move's fence settlement rides the accepted
      // merge inside this transaction, after its own update.
      if(settleFences)settleSupersededFencesInTx(this.store,t.id,settleFences,now(),appliedCoordinatorRunId);
      if(retained)retained.settleOperation(this.store.task(t.id));
      return this.store.task(t.id);
    });
  }
  /** Exact-head identity of the retained workspace from the filesystem. Safe inside a transaction. */
  private retainedExternalMergeIdentity(t: Task): string {
    if (!t.directory || !t.workspaceId || !t.prHead || t.branch !== `ns-${t.id}` || t.branch === t.baseBranch)
      throw Error('Retained Nucleus workspace and recorded source identity are required');
    const root=realpathSync(t.directory), repo=realpathSync(t.repoPath);
    let checkout, repoGit;
    try {
      checkout = readGitCheckout(t.directory);
      repoGit = readGitCheckout(t.repoPath);
    } catch {
      throw Error('Retained workspace is aliased or is not its Git root');
    }
    if (root!==resolve(t.directory) || root===repo || checkout.toplevel!==root)
      throw Error('Retained workspace is aliased or is not its Git root');
    if (checkout.commonDir!==repoGit.commonDir)
      throw Error('Retained workspace belongs to another repository');
    if (!t.repository || normalizeRepositoryOrigin(checkout.origin)!==normalizeRepositoryOrigin(t.repository))
      throw Error('Retained workspace origin does not match the recorded repository');
    if (checkout.branch!==t.branch)
      throw Error('Retained workspace is dirty or switched');
    if (checkout.head!==t.prHead) throw Error('Retained workspace does not match the recorded task source');
    return checkout.head;
  }
  /** Identity plus an async clean-tree walk. Call before the transaction; re-check identity inside it. */
  private async proveRetainedExternalMergeSource(t: Task): Promise<string> {
    const head = this.retainedExternalMergeIdentity(t);
    if (await queueCheckoutStatus(t.directory!, '--no-optional-locks', 'status', '--porcelain'))
      throw Error('Retained workspace is dirty or switched');
    if (this.retainedExternalMergeIdentity(t) !== head)
      throw Error('Retained workspace does not match the recorded task source');
    return head;
  }
  async recoverExternalMerge(t: Task) {
    if (this.resolution.paused() || !this.adapter.externalMerge || t.resolution.mergeIntent || !t.workspaceId || (!t.agentId&&!t.reviewEntry) || !(t.reviewEntry?.prNumber||t.completion?.prNumber || t.resumePrNumber) || ['done','cancelled','queued'].includes(t.phase)) return false;
    if (t.resolution.mergedCommit && (!t.resolution.externalMerge || t.resolution.syncedCommit)) return false;
    if (this.store.runs(t.id).some(r=>!r.released&&!r.agentId)) return false;
    /**
     * `recordHead` decides whether this pass may set the task's recorded head
     * from the observed merge. A freshly observed merge does; a re-entry for an
     * already-recorded merge does not, because the accepted route already decided
     * it: an ordinary acceptance recorded the merged head at `prHead`, and a
     * never-dispatched review-entry acceptance deliberately kept the task's
     * recorded source head there and put the merged head in `mergeHead` (task
     * 408). Copying `mergeHead` into `prHead` on the next tick would erase that
     * provenance rather than restore it.
     */
    const finishExternalMerge = (current: Task, head: string, commit: string, recordHead: boolean, settleEpisode: boolean) => {
      const latest = this.resolution.assignIntegrationTurn(current);
      const holding = !this.resolution.hasEarlierIntegrationTurn(latest);
      const headPatch = recordHead ? { prHead: head } : {};
      // A freshly observed merge supersedes every run the task holds, so the recovery
      // episode they carried closes with the merge instead of outliving it (Queue #680).
      const episodeDetail = 'External merge observed: the recovery run it superseded no longer holds the episode';
      const episode = settleEpisode ? this.resolution.recovery.settledEpisodeChanges(latest, episodeDetail) : null;
      this.resolution.update(latest,{externalMerge:true,mergeHead:head,mergedCommit:commit,currentRunId:null,attention:false,externalMergePreAttention:null,...mergedWithNonePatch(latest,head),...(episode??{})},holding
        ? {phase:'syncing',...headPatch,coordinatorGeneration:latest.coordinatorGeneration+1,reason:'External merge verified; synchronizing main before coordinator closeout'}
        : {phase:'merging',...headPatch,reason:'External merge verified; waiting for repository integration turn'},'external_merge_observed');
      if (episode) this.store.event(latest.id, 'recovery_episode_settled', episodeDetail);
      return true;
    };
    if (t.resolution.mergedCommit) {
      if (!(t.resolution.externalMerge && !t.resolution.syncedCommit && t.phase !== 'syncing' && t.phase !== 'closing')) return false;
      if (!await this.resolution.executionLease(t, undefined, false, true) || this.resolution.paused()) return false;
      return finishExternalMerge(this.store.task(t.id), t.resolution.mergeHead ?? t.prHead!, t.resolution.mergedCommit, false, false);
    }
    try {
      // A read that cannot change an answer is not made again inside the window.
      // Skipping is "no merge observed this pass", exactly like a probe that found
      // the PR open, so the task's own path still advances; it never records a
      // merge, and a changed head, PR, phase, run, generation or attention
      // identity forces the read immediately.
      if (!this.externalMergeProbeDue(t)) return false;
      if (!await this.resolution.executionLease(t, undefined, false, true) || this.resolution.paused()) return false;
      const observed = this.externalCheckIdentity(this.store.task(t.id));
      const result=await this.adapter.externalMerge(t);
      this.noteExternalMergeProbe(t);
      if (this.resolution.paused()) return false;
      if (!result) {
        // A fresh successful probe proves the PR still open. Re-prove the lease after the
        // await, then apply both writes in one transaction that re-checks the identity read
        // before the probe.
        if (!await this.resolution.executionLease(this.store.task(t.id), undefined, false, true) || this.resolution.paused()) return false;
        this.store.transaction(() => {
          const latest = this.store.task(t.id);
          const incident = this.externalCheckIdentity(latest) === observed ? this.recoveredExternalCheckIncident(latest) : null;
          if (incident) {
            this.resolution.resolveIncident(latest, incident.runId, 'Fresh external merge probe found the PR open; external-check incident recovered');
            this.store.event(t.id, 'external_merge_check_incident_resolved', JSON.stringify({ incidentId: incident.id, runId: incident.runId, head: latest.prHead ?? null }));
          }
          const restored = this.store.task(t.id);
          if (restored.resolution.attention && restored.reason.startsWith(EXTERNAL_MERGE_CHECK_REASON_PREFIX))
            this.resumeFromExternalMergeCheck(restored, EXTERNAL_MERGE_CHECK_RECOVERED_REASON);
        });
        return false;
      }
      if (!await this.resolution.executionLease(this.store.task(t.id), undefined, false, true) || this.resolution.paused()) return false;
      const current=this.store.task(t.id);
      if (this.externalCheckIdentity(current) !== observed) return false;
      if (!current.prHead || result.head !== current.prHead || !/^[a-f0-9]{40}$/.test(result.commit))
        throw new Error('External merge head differs from recorded task work');
      // Task 993: a merge counts only for the task whose head was reviewed. A
      // fresh observation advances to syncing and closeout only when recorded
      // review evidence binds the merged head; otherwise the merge is recorded
      // as a fact and the task stops for its planner. Nothing is advanced,
      // reverted or synced, and the already-recorded-merge re-entry below never
      // re-decides an accepted route, so the gate lives only on this path. A
      // submission that explicitly skipped PR review keeps its previous merge
      // behavior, the same rule the Queue-owned gates apply.
      if (this.resolution.reviewRequired(current) && !mergeReviewEvidenceAt(current, result.head)) {
        this.stopUnreviewedExternalMerge(current, result.head, result.commit);
        return true;
      }
      this.store.transaction(()=>{
        for(const run of this.store.runs(t.id).filter(r=>!r.released))this.store.putRun({...run,released:true,status:'superseded'});
        finishExternalMerge(current, result.head, result.commit, true, true);
      });
      return true;
    } catch(error) {
      // Ordinary probe failures are windowed like completed reads but never imply
      // an open PR. A timed-out local Git read is different: it made no witness,
      // so leave the probe due and retry it on the next pass.
      if (!this.resolution.paused()) {
        if (error instanceof GitReadTimeoutError) this.resolution.waiting(this.store.task(t.id), error.message, 'external_unavailable');
        else {
          if (error instanceof ForgeOutageError && this.resolution.gitTransientFailure?.(this.store.task(t.id), error)) return true;
          this.noteExternalMergeProbe(t);
          if (error instanceof ForgeOutageError) this.resolution.waiting(this.store.task(t.id), error.message, 'external_unavailable');
          else if (isTransportFailure(error)) this.resolution.transportDeferred(this.store.task(t.id), error);
          else if (error instanceof LoginSessionFaultError || isLoginSessionFault(error)) this.resolution.environmentDeferred(this.store.task(t.id), error);
          else this.resolution.attention(this.store.task(t.id), `${EXTERNAL_MERGE_CHECK_REASON_PREFIX} ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return true;
    }
  }
  /**
   * Whether the automatic probe may read the forge for this task now. A task
   * parked on the probe's own check is a stuck state with its own exit, so it is
   * asked about immediately; every other task waits for its window, its identity
   * to change, or the first pass after a restart.
   */
  private externalMergeProbeDue(task: Task): boolean {
    if (task.resolution.attention && task.reason.startsWith(EXTERNAL_MERGE_CHECK_REASON_PREFIX)) return true;
    const last = this.externalMergeProbes.get(task.id);
    return !last || last.identity !== this.externalMergeProbeIdentity(task) || Date.now() - last.at >= this.externalMergeProbeMs;
  }
  /**
   * The lifecycle facts that make an already-made read stale. Version and event
   * history are excluded on purpose: observation writes advance them, so they
   * would defeat the window without changing what the forge would answer.
   */
  private externalMergeProbeIdentity(task: Task): string {
    return JSON.stringify([task.prUrl ?? null, task.prHead ?? null, task.phase,
      task.resolution.currentRunId ?? null, task.agentId ?? null, task.coordinatorGeneration,
      task.reviewEntry?.prNumber ?? null, task.completion?.prNumber ?? null, task.resumePrNumber ?? null]);
  }
  private noteExternalMergeProbe(task: Task): void {
    const identity = this.externalMergeProbeIdentity(task);
    this.externalMergeProbes.delete(task.id);
    if (this.externalMergeProbes.size >= EXTERNAL_MERGE_PROBE_LIMIT) this.externalMergeProbes.delete(this.externalMergeProbes.keys().next().value!);
    this.externalMergeProbes.set(task.id, { at: Date.now(), identity });
  }
  /** Task version, stored incident and current run: the identity a probe must find unchanged. */
  private externalCheckIdentity(task: Task): string {
    const run = task.resolution.currentRunId ? this.store.run(task.resolution.currentRunId) : null;
    return JSON.stringify([task.version, task.resolution.incident ?? null, run]);
  }
  /**
   * The reconciling external-check incident that a fresh successful probe proves
   * recovered, or null. It must be the reviewer incident of the one unreleased,
   * running reviewer run whose fingerprint still derives from its own detail, with no
   * other attention, recovery, stall, merge, publication or uncertain effect.
   */
  private recoveredExternalCheckIncident(task: Task): Incident | null {
    const incident = task.resolution.incident, run = task.resolution.currentRunId ? this.store.run(task.resolution.currentRunId) : null;
    if (!incident || !run || this.resolution.paused() || task.removedAt || task.phase !== 'reviewing' || isDispositionActive(task) || isDispositionComplete(task) || dispatchBlocked(task)) return null;
    if (incident.status !== 'reconciling' || incident.action !== '' || incident.role !== 'reviewer' || incident.runId !== run.id) return null;
    if (!incident.detail.startsWith(EXTERNAL_MERGE_CHECK_REASON_PREFIX)) return null;
    const runs = this.store.runs(task.id);
    if (run.role !== 'reviewer' || run.status !== 'running' || run.released || run.completion || runs.some(item => !item.released && item.id !== run.id)) return null;
    if (incidentKey(task, run, incident.detail, runs).id !== (incident.fingerprint || incident.id)) return null;
    if (task.resolution.attention && !task.reason.startsWith(EXTERNAL_MERGE_CHECK_REASON_PREFIX)) return null;
    if (task.resolution.recoveryActive || task.resolution.recovery && task.resolution.recovery.status !== 'resolved') return null;
    if (task.resolution.stalledTurnStop && task.resolution.stalledTurnStop.status !== 'completed') return null;
    if (task.resolution.mergeIntent || task.resolution.mergeHead || task.resolution.mergedCommit || task.resolution.externalMerge || task.resolution.integrationTurn ||
        task.resolution.mergeResponseOutcome === 'uncertain' || task.resolution.mergeRetryOutcome === 'uncertain' || this.store.getMeta(`reviewPublication:${run.id}`))
      return null;
    return incident;
  }
  /**
   * Restore the phase and reason a task held before a transient external-merge
   * check parked it, clearing the flag and the recorded pre-attention state. When
   * no record exists (an older strand, or a fault that never recorded one) the
   * remembered reason must not pretend to be a resumable phase, so the recovery
   * reason alone is written; the lifecycle sweep can then resume it.
   */
  private resumeFromExternalMergeCheck(task: Task, fallbackReason: string): Task {
    const pre = task.resolution.externalMergePreAttention;
    return this.resolution.update(task, { attention: false, externalMergePreAttention: null },
      pre ? { phase: pre.phase, reason: pre.reason } : { reason: fallbackReason },
      'external_merge_check_recovered');
  }
  /**
   * Task 993: a freshly observed external merge at a head no recorded review
   * evidence binds is a fact, not an outcome. One transaction supersedes the
   * quiet runs the advance would have released and records the merge fact;
   * the task then parks inside the blocker ladder for its planner, which owns
   * the route: a fresh review of the merged head (`move to=review`) or an
   * operator source acceptance (`move to=closeout`). A repeated observation
   * on the same cause attaches to the open escalation instead of asking again.
   */
  private stopUnreviewedExternalMerge(current: Task, head: string, commit: string): void {
    // The cause is a stable per-task, per-head digest: the ladder's escalation
    // parser reads a 64-hex cause, and a repeated observation on the same cause
    // must join the open escalation instead of opening another one.
    const cause = digest(["unreviewed-external-merge", current.id, head].join(":"));
    const prNumber = current.reviewEntry?.prNumber ?? current.resumePrNumber ?? current.completion?.prNumber ?? null;
    const detail = `The PR${prNumber ? ` #${prNumber}` : ''} merged outside Queue at head ${head} (merge commit ${commit}), but no recorded ready_to_merge review, reviewer source approval, qualified owner acceptance or operator source acceptance binds that merged head. The merge is recorded as an observed fact; the task stopped for its planner and nothing was advanced, synced or reverted.`;
    const existing = findOpenPlannerEscalation(this.store.eventsAll(current.id) as LadderEvent[], cause);
    this.store.transaction(() => {
      const stopped = this.store.runs(current.id).filter(run => !run.released);
      for (const run of stopped) this.store.putRun({ ...run, released: true, status: 'superseded' });
      this.store.event(current.id, 'external_merge_unreviewed', `${detail}${stopped.length ? ` Superseded quiet runs: ${stopped.map(run => run.id).join(', ')}.` : ''}`.slice(0, 4000));
    });
    if (existing) {
      this.resolution.waiting(this.store.task(current.id), escalationWaitDetail.attached(existing.id), 'escalated');
      return;
    }
    // The park's phase rides its own write BEFORE the escalation records its
    // stop: a lifecycle-changing write clears a stop that merely repeats, so
    // the escalated park is recorded after the phase settled (store.update's
    // stop rule).
    const parked = this.store.task(current.id);
    if (parked.phase !== 'blocked' && !['done', 'cancelled'].includes(parked.phase))
      this.resolution.update(parked, {}, { phase: 'blocked' }, 'external_merge_unreviewed_stopped');
    const question = `The responsible task "${current.title}"'s PR${prNumber ? ` #${prNumber}` : ''} merged outside Queue at head ${head} (merge commit ${commit}) with no recorded review evidence binding that merged head, so Nucleus did not count the merge. Existing routes: a fresh review of the merged head through move to=review, or an operator source acceptance through move to=closeout. Choose how it proceeds: ${PLANNER_ESCALATION_CHOICES.join('; ')}. You may also answer directly with the direction Queue should follow.`;
    this.resolution.openPlannerEscalation(this.store.task(current.id), {
      cause, runId: null, question, payload: { cause, head, commit, prNumber, question },
      causeDetail: detail.slice(0, 2000),
    });
  }
  /**
   * Lifecycle sweep (project-a #1837): a task parked in `needs_attention` with the
   * attention flag already cleared, no current run and no unreleased run has
   * nothing that will advance it. When the previous episode recorded the state a
   * transient external-merge check interrupted, restore that phase and reason so
   * the ordinary resolution path runs again instead of idling.
   */
  resumeClearedAttention(t: Task): Task | null {
    if (t.phase !== 'needs_attention' || t.resolution.attention || t.resolution.currentRunId) return null;
    if (this.store.runs(t.id).some(run => !run.released)) return null;
    const pre = t.resolution.externalMergePreAttention;
    const checkReason = t.reason.startsWith(EXTERNAL_MERGE_CHECK_REASON_PREFIX) || t.reason === EXTERNAL_MERGE_CHECK_RECOVERED_REASON;
    // A record beside any other reason was superseded by the action that wrote that
    // reason; restoring an old phase over it would undo the pending resolution.
    if (!checkReason) {
      if (pre) this.resolution.update(t, { externalMergePreAttention: null }, {}, 'external_merge_pre_attention_superseded');
      return null;
    }
    if (pre) return this.resolution.update(t, { externalMergePreAttention: null }, { phase: pre.phase, reason: pre.reason }, 'external_merge_pre_attention_restored');
    // A strand from before the record existed carries the recovered reason on a
    // task whose accepted PR is still final: resume the accepted-PR reconciliation
    // that was pending when the check failed, and let advance() route it.
    if (t.reason !== EXTERNAL_MERGE_CHECK_RECOVERED_REASON) return null;
    if (t.completion?.status !== 'ready_for_review' || !t.prHead || !t.workspaceId) return null;
    return this.resolution.update(t, { attention: false }, { reason: ACCEPTED_PR_RECONCILIATION_REASON }, 'external_merge_check_recovered_resumed');
  }
}
