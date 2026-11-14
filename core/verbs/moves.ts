import { MOVE_WORK_AUTHOR_REFUSAL, MOVE_WORK_REPLACEMENT_REFUSAL, MOVE_REVIEW_WORKSPACE_REFUSAL, MOVE_MERGE_ACCEPTANCE_REFUSAL } from './control-refusals';
import { RETAINED_PREREQUISITE_REFUSAL } from './verb-refusal-text';
import { REMOVED_TASK_REFUSAL } from './control-refusals';
import { readyReviewAtHead } from '../recovery/task-reasons';
import { MOVE_REVIEW_PR_REFUSAL, moveStateRefusal } from './control-refusals';
import type { OwnerAcceptanceRecord, Run, Task, TaskControlInput } from "../../shared/contracts";
import { holdsOf, taskControlInputSchema } from "../../shared/contracts";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import type { VerifiedEnclosingOperation } from "../planning/enclosing-operation";
import { verifyEnclosingOperation } from "../planning/enclosing-operation";
import { executionParticipants } from "../machine/execution-participants";
import { settleSupersededFencesInTx } from "../recovery/fence-settlement";
import { assertCanonicalPrSource, evidenceOnlyPr, ForeignPrIdentity, taskHasPr, taskPrNumber } from "../forge/index";
import { releasePatch } from "../merge/merge-hold";
import { runsUnchangedSince } from "../recovery/observation-advance";
import type { WorkspaceDiscard } from "../workspaces/orphan-worktree";
import { workspaceDiscardKey } from "../workspaces/orphan-worktree";
import { RestartRefusal, currentReadyPrEvidence, currentRouteProfile, plainHandoverFreshRestart, qualifiedAcceptanceEligibility, unreleasedLaunchFence } from "./owner-verbs";
import type { AgentObservation } from "../host/adapter";
import { hostFailureRefusalDetail } from "../host/errors";
import { blockingRecoveryEffectsRefusal } from "../recovery/recovery-effects";
import type { ContinuedPrBinding } from "../resolution";
import { REVIEW_FRESH_REPLACEMENT_EXIT, reviewContinuationState, reviewContinuationWait, reviewInProgress, reviewerIdentityAtHead, retainedReaderStateDecision, retainedReaderStoredRefusal, retainedReaderUnavailableRefusal, keepRetainedReviewer } from "../review/review-continuation";
import { validateNamedProfile } from "../dispatch/routing";
import { DurableFenceRefusal, runFenceRefusal, runSettlementFence } from "../intake/run-settlement";
import { proofOnlyReceiptAwaitingReview } from "../qa/proof-execution";
import { now } from "../store/store";
import { OPERATOR_WORKER_REMAP_REASON, operatorReplacementPending } from "../recovery/task-reasons";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Engine } from "../engine";

/** Decide how an observed retained reader is treated, without sending a turn. */
export function retainedReaderDecision(input: {
  reader: boolean; state: ReturnType<typeof reviewContinuationState>; busy: boolean;
  status: string; waitReason: string; agentId: string | null; runId: string;
}): { kind: 'preserve' | 'continue' | 'fallthrough' } | { kind: 'refuse'; message: string } {
  const { reader, state, busy, status, waitReason, agentId, runId } = input;
  if (!reader) return { kind: busy ? 'preserve' : 'fallthrough' };
  const stored = retainedReaderStateDecision(state);
  const refusal = retainedReaderStoredRefusal(state, waitReason);
  if (refusal) return { kind: 'refuse', message: refusal };
  if (status === 'closed') return { kind: 'refuse', message: retainedReaderUnavailableRefusal() };
  if (state === 'continuing' || busy) return { kind: 'preserve' };
  if (stored === 'awaiting' && status === 'idle') return { kind: 'continue' };
  return { kind: 'refuse', message: `The retained reviewer (agent ${agentId}, run ${runId}) is ${status} with an awaiting checkpoint, so move to review cannot continue it. ${REVIEW_FRESH_REPLACEMENT_EXIT}` };
}

/**
 * Task 408: a refused review-entry external-merge reconciliation is definite. It
 * only reads evidence (forge, workspace, owners) and commits in one store
 * transaction, so a refusal with no merge record proves nothing was accepted —
 * even when the observation it names was unreadable, active or unknown, which a
 * prose classifier would otherwise read as an uncertain outcome.
 */
export class ExternalMergeRefusal extends Error {
  constructor(message: string) { super(message); this.name = 'ExternalMergeRefusal'; }
}

/**
 * The owner's `move` verb: to work, review, merge and closeout, and the external
 * merge reconciliation closeout runs. Same-name `Engine` methods delegate here.
 * `store`, `adapter` and `resolution` read the engine per call: tests replace the
 * adapter.
 */
export class MoveControls {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get resolution() { return this.engine.resolution; }
  /**
   * Task 404/408: the authenticated durable invocation executing this move
   * right now. `queue.task` persists the `task_control` operation before the
   * engine performs it, so the review-entry pre-first-run boundary — which
   * refuses any other unfinished operation — must recognise this one as its own
   * admitted control rather than a competing writer. Derived from the stored
   * record on every call, so a settled, foreign, differently versioned or
   * changed invocation exempts nothing; only the move that reads that
   * boundary is offered at all.
   */
  moveEnclosingInvocation(input: TaskControlInput, operationId?: string): () => VerifiedEnclosingOperation | undefined {
    if (input.action !== "move" || input.to !== "closeout") return () => undefined;
    return () => verifyEnclosingOperation(this.store, input, operationId);
  }

  async applyTaskControlMove(input: TaskControlInput, operated: <T>(result: T) => T, operationId?: string): Promise<Task> {
    const before = this.store.task(input.taskId);
    const eventCount = this.store.eventsAll(input.taskId).length;
    // Task 404: the one authenticated durable invocation executing this move is
    // re-proved from the stored operation at every boundary that reads the
    // source-only fact, so a settled, foreign, changed or differently versioned
    // invocation exempts nothing.
    const enclosing = this.engine.moveEnclosingInvocation(input, operationId);
    const attempt = (version: number) => {
      const moveInput = { taskId: input.taskId, version, reason: input.reason!, instruction: input.instruction, caller: input.caller,
        qualification: input.qualification, head: input.head, relayed: input.relayed, delegated: input.delegated, relayNote: input.note };
      return input.to === "work" ? this.engine.moveToWork(moveInput)
        : input.to === "merge" ? this.engine.moveToMerge(moveInput)
        : input.to === "closeout" ? this.engine.moveToCloseout({ ...moveInput, enclosing })
        : this.engine.moveToReview({ taskId: input.taskId, version, reason: input.reason!, reviewer: input.reviewer,
          caller: input.caller, prNumber: input.prNumber,
          fresh: input.to === "review" ? input.fresh : undefined }, operationId);
    };
    // Round 4 (review #533): cancelling a turn is remote, so a callback can land
    // while it is in flight. Once this move has stopped live work, a concurrent
    // change does not refuse it: the move re-plans once against the fresh
    // state, where the cancelled run is idle and settles. Only a real invariant
    // can refuse the re-plan.
    const cancelsBefore = this.store.eventsAll(input.taskId).filter(event => event.kind === "owner_stop_sent").length;
    let result: Task;
    try { result = await attempt(input.version); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = this.store.eventsAll(input.taskId).filter(event => event.kind === "owner_stop_sent").length > cancelsBefore;
      if (!cancelled || !/^(Task changed|Task or run changed|A run started during the move|A run changed during the move)/.test(message)) throw error;
      this.store.event(input.taskId, "owner_move_replanned", message.slice(0, 2000));
      result = await attempt(this.store.task(input.taskId).version);
    }
    if (result.version === before.version && this.store.eventsAll(input.taskId).length === eventCount)
      throw new DurableFenceRefusal('The move could not change the task; read next and use force with a reason if a gate is blocking it');
    void this.engine.cleanContext(() => this.engine.wakeTask(result.id));
    void this.engine.cleanContext(() => this.engine.wakeRepository(result.repoPath));
    return operated(result);
  }

  /**
   * Spec 050 `move to=review`: a fresh independent review at the current PR
   * head. Prior review credit is superseded and kept as history, and an
   * answered attention episode is settled. A checkpointed or stopped reviewer
   * run yields to the move: it is superseded without a verdict, history kept.
   * A workerless review-entry task with a changed PR head must return to work
   * so a revision worker authors the change in its task workspace first.
   * A retained PR number can restore the binding after routing; source,
   * participant and delivery proofs still precede the atomic settlement.
   */
  async moveToReview(input:{taskId:string;version:number;reason:string;reviewer?:{profileId:string;reason:string};caller?:string;prNumber?:number;fresh?:boolean},operationId?:string):Promise<Task>{
    const task=this.store.task(input.taskId);
    if(task.removedAt)throw Error(REMOVED_TASK_REFUSAL);
    this.engine.requireOwnerControlCurrent(task,input.version,'Task changed; refresh before retrying');
    const stateRefusal = moveStateRefusal(task, "review");
    if(stateRefusal)throw Error(stateRefusal);
    if(proofOnlyReceiptAwaitingReview(task)) return this.moveProofOnlyReceiptToReview(input,operationId);
    // Project-d #117 (Tom, 2026-10-23): with no bound PR, the PR and exact head
    // the current authenticated ready result names are bound with the review
    // entry, under every retained-PR proof below and the exact-head check.
    const runsBefore=this.store.runs(task.id);
    const evidence=!task.prUrl&&!task.resumePrNumber?currentReadyPrEvidence(task,runsBefore):null;
    if(!task.prUrl&&!task.resumePrNumber&&!evidence)throw Error(MOVE_REVIEW_PR_REFUSAL);
    const prNumber=evidence?.prNumber??taskPrNumber(task);
    if(input.prNumber!==undefined&&input.prNumber!==prNumber)throw Error(evidence
      ?`Move to review must use PR #${prNumber}, which the current ready result names`:`Move to review must use the retained task PR #${prNumber}`);
    const pr=await this.adapter.verifyPr(task,prNumber);
    if(evidence&&pr.head!==evidence.head)
      throw Error(`PR #${prNumber} is at ${pr.head}, not the head ${evidence.head} its current ready result reports; nothing was bound`);
    // Reapply only a verdict pending at the verified current head. A newer PR
    // head supersedes it, and an explicit fresh review owns this transition.
    if(input.fresh!==true&&pr.head===task.prHead){
      const pendingReview=await this.resolution.reapplyPendingReview(task);
      if(pendingReview==='applied')return this.store.task(task.id);
      if(pendingReview==='blocked')throw Error('A released accepted review is still pending; move to review was refused until its lifecycle result is settled');
    }
    const retained=!task.prUrl&&(Boolean(task.resumePrNumber)||Boolean(evidence));
    const observeRetainedWorkers=async()=>{
      if(!retained)return;
      if(!task.agentId||!task.workspaceId||!task.directory||!task.profile||operatorReplacementPending(task))
        throw Error(MOVE_REVIEW_WORKSPACE_REFUSAL);
      for(const agentId of new Set([task.agentId,...task.retiredWorkers.map(worker=>worker.agentId)])){
        const observed=await this.engine.host.observe(agentId);
        if(observed.id!==agentId||observed.workspaceId!==task.workspaceId||observed.active||observed.activeTurnId||observed.permissions||!['idle','error','closed'].includes(observed.status))
          throw Error('Move to review requires the retained workers to be observably inactive in the task workspace');
      }
    };
    const checkRetainedEffects=()=>{
      if(!retained)return;
      const refusal=blockingRecoveryEffectsRefusal(this.store,this.store.task(task.id),{kinds:['run-delivery','publication','review-delivery','merge-response']});
      if(refusal)throw Error(refusal);
    };
    checkRetainedEffects();
    await observeRetainedWorkers();
    // Spec 050 (#3569): finished runs settle by observation before the run
    // fence — including a completed reviewer run, whose verdict the move
    // supersedes as credit; one that cannot settle refuses here, with its own
    // reason and nothing written. The release lands inside the move's
    // transaction, so a refused move changes nothing.
    // Round 4: other roles' runs are displaced (a busy turn is cancelled below,
    // after every check that can refuse); only a durable side effect refuses.
    const reviewRunsBefore=this.store.runs(task.id);
    const finished=await this.engine.collectVerbFinishedRuns(task.id,run=>run.role==='reviewer'&&!run.completion,{displace:true});
    if(finished.fenced.length)throw new DurableFenceRefusal(this.engine.displaceRefusal(finished.fenced[0]!));
    const displaced=[...finished.settleable,...finished.live];
    const settling=new Set(displaced.map(run=>run.id));
    const candidates=this.store.runs(task.id).filter(run=>!run.released&&!settling.has(run.id));
    // A stopped reviewer run — observed idle with no turn, whatever its stored
    // `active` flag says — is exactly the state a fresh review supersedes. A
    // live reviewer turn is cancelled first, then superseded the same way.
    const stoppedReviewers=new Set<string>();
    const liveReviewers:Run[]=[];
    for(const run of candidates) if(run.role==='reviewer'&&!run.completion){
      const why=this.engine.runDurableFence(this.store.task(task.id),run);
      if(why)throw new DurableFenceRefusal(this.engine.displaceRefusal({run,why}));
      if(await this.engine.observedRunLiveness(run)===false)stoppedReviewers.add(run.id); else liveReviewers.push(run);
    }
    const live=candidates.find(run=>!stoppedReviewers.has(run.id)&&!liveReviewers.includes(run));
    if(live)throw new DurableFenceRefusal(this.engine.displaceRefusal({run:live,why:'its state changed during the move'}));
    if(evidence)assertCanonicalPrSource(pr,prNumber);
    if(retained){
      if(!this.adapter.verifyResume||!this.adapter.verifyInspectedRevisionHead)throw Error('Retained PR source verification is unavailable');
      await this.adapter.verifyResume(task);
      await this.adapter.verifyInspectedRevisionHead(task,prNumber,pr.head);
      await observeRetainedWorkers();
    }
    // Tom, 2026-10-27 ("Preserve the reader for everyone", decision 029a631e):
    // a valid reader already reviewing this exact head is preserved and
    // continued, not replaced. The state comes from the durable checkpoint and
    // delivery records, and the reader is freshly observed before either
    // decision. Only a genuinely awaiting checkpoint whose reviewer is idle
    // delegates to the ordinary retained-restart admission and delivery path;
    // reading, reserved, uncertain or already-delivered work sends no new turn
    // merely because no verdict exists, and a reader that cannot continue is
    // explicit rather than silently replaced. A reader with no saved coverage is
    // preserved while it is still reading. An idle plain-handover reader without
    // a checkpoint cannot carry its view to a new run, so it requires an explicit
    // fresh restart; other idle readers follow the ordinary move path.
    // Explicit replacement takes the ordinary displacement path even when a
    // checkpointed round already holds a result and cannot continue, but an
    // unprovable reader binding still refuses before any displacement.
    const identity=reviewerIdentityAtHead(this.store.task(task.id),this.store,pr.head);
    if(identity.kind==='refused')throw Error(identity.refusal);
    const reading=input.fresh!==true&&identity.kind==='valid'?identity.run:null;
    const reader=reading&&reviewInProgress(reading)?reading:null;
    if(reading){
      const readerTask=this.store.task(task.id);
      const state=reader?reviewContinuationState(readerTask,this.store):null;
      const wait=reviewContinuationWait(readerTask,this.store);
      let observed:AgentObservation;
      try{observed=await this.engine.host.observe(reading.agentId!);}
      catch(error){throw Error(`Move to review cannot observe the retained reviewer (${hostFailureRefusalDetail(error)}); restore observation before moving, and no review turn was sent`);}
      const latestTask=this.store.task(task.id);
      this.engine.requireOwnerControlCurrent(latestTask,input.version,'Task changed; refresh before retrying');
      const latestReader=this.store.run(reading.id);
      if(!latestReader||latestReader.released||latestReader.completion||latestReader.head!==pr.head
        ||latestReader.agentId!==reading.agentId||latestTask.resolution.currentRunId!==reading.id)
        throw Error('The retained reviewer changed during the move; refresh before retrying');
      // A failed, ambiguous or relocated observation never stands in for a
      // preserved reader: unknown is not absent.
      if(observed.id!==reading.agentId||observed.workspaceId!==reading.workspaceId)
        throw Error('Move to review cannot prove the retained reviewer in its workspace; no review turn was sent');
      const busy=observed.active||Boolean(observed.activeTurnId)||observed.permissions;
      const decision=retainedReaderDecision({reader:Boolean(reader),state,busy:Boolean(busy),status:observed.status,
        waitReason:wait.reason,agentId:reading.agentId,runId:reading.id});
      if(decision.kind==='refuse')throw Error(decision.message);
      if(decision.kind==='preserve')return this.engine.preserveRetainedReviewer(input,readerTask,reader??reading,pr,finished,reader ? state??'reading' : 'reading');
      if(decision.kind==='continue')
        return this.engine.continueRetainedReviewer(readerTask,{version:input.version,reason:input.reason,
          instruction:'Continue the existing task under its current approved instruction source and within its approved scope.',
          ownerStopYields:this.engine.isOwnerCall(),verb:'move',
          deferrable:taskControlInputSchema.parse({taskId:task.id,version:task.version,action:'move',to:'review',reason:input.reason,
            ...(input.caller?{caller:input.caller}:{}),...(input.prNumber!==undefined?{prNumber:input.prNumber}:{})}) as TaskControlInput},operationId);
      const refusal=plainHandoverFreshRestart(latestTask,this.store.runs(task.id));
      if(refusal)throw new RestartRefusal(`Move to review preserves the retained reader. ${refusal}`);
    }
    // A workerless review-entry task cannot adopt an externally changed head.
    // Return it to work so Queue's revision worker authors the changes in the
    // task workspace before a fresh review is requested.
    if (task.reviewEntry && !task.agentId && pr.head !== task.prHead)
      throw Error('The review-entry PR head changed; use move to=work to start the revision worker in the task workspace before moving to review');
    // A requested reviewer is preflighted before anything is written: its
    // model must differ from the author's, and neither may be an opaque route.
    if(input.reviewer){
      this.engine.requireProfileCatalog();
      const {profile}=validateNamedProfile(input.reviewer.profileId,'reviewer',task.scope,this.engine.profiles,this.store.pool(),input.reviewer.reason.trim(),task.thinkingOptionId);
      this.engine.requireAvailableGroup(input.reviewer.profileId);
      const modelKey=(value:string)=>value.split('/').at(-1)!.toLowerCase();
      const reviewerModel=modelKey(profile.model);
      const author=task.workerModel??task.profile?.model;
      const authorModels=(author?[author]:task.reviewEntry?.authorDeclaration.models??[]).map(modelKey);
      if(reviewerModel==='default')throw Error(`Requested reviewer ${input.reviewer.profileId} uses an opaque provider-default route that cannot prove review independence`);
      if(authorModels.includes('default'))throw Error('The author whose head is under review uses an opaque provider-default route that cannot prove review independence');
      if(authorModels.includes(reviewerModel))throw Error(`Requested reviewer ${input.reviewer.profileId} shares the current author's model ${profile.model}; the reviewer model must differ from the model of the worker whose head is under review`);
    }
    if(finished.live.length||liveReviewers.length)this.engine.assertUnchangedBeforeCancel(task.id,input.version,reviewRunsBefore);
    await this.engine.cancelDisplacedTurns(task.id,[...finished.live,...liveReviewers],'move review');
    for(const run of liveReviewers)stoppedReviewers.add(run.id);
    // Project-d #117 review: a binding never rests on an observation made
    // before a remote cancel. After any cancellation, the retained workers are
    // observed again; the published clean source is proven last, on the task
    // lane, immediately before the accepting transaction. An active worker or a
    // moved source refuses with nothing bound.
    if(evidence){
      await observeRetainedWorkers();
      await this.adapter.verifyResume!(task);
      await observeRetainedWorkers();
    }
    // Spec 057 (task 553): on a responsible task the move keeps the retained
    // reviewer for the delta review at the new head unless fresh is asked for
    // or the retained reviewer is closed or unavailable, so the one-reviewer
    // rule holds by default. The closed check is one observation before the
    // accepting transaction; every other check re-reads the store inside it.
    const freshAsked = input.fresh === true;
    const observedRetained = !freshAsked && task.resolution.reviewerAgentId
      ? await this.engine.host.observe(task.resolution.reviewerAgentId).catch(() => null)
      : null;
    const retainedClosedAtObserve = Boolean(observedRetained
      && observedRetained.id === task.resolution.reviewerAgentId && observedRetained.status === 'closed');
    return this.engine.control(async()=>{
      if(evidence)await this.adapter.verifyInspectedRevisionHead!(task,prNumber,pr.head);
      const settled=await this.engine.control(()=>this.store.transaction(()=>{
      const current=this.store.task(task.id);
      this.engine.requireOwnerControlCurrent(current,input.version,'Task changed; refresh before retrying');
      if(retained&&!runsUnchangedSince(runsBefore,this.store.runs(task.id)))throw Error('A run changed during the move; refresh before retrying');
      if(evidence&&!isDeepStrictEqual(currentReadyPrEvidence(current,this.store.runs(task.id)),evidence))throw Error('The ready result changed during the move; refresh before retrying');
      checkRetainedEffects();
      // Finished runs of other roles release first: a recovery episode's
      // accepted action is recorded as not applied on the resolved episode, and
      // the re-read below carries that record through the move's own update.
      this.engine.releaseDisplacedRunsInTx(task.id,displaced.map(run=>run.id),`move review: ${input.reason}`);
      if(this.store.runs(current.id).some(run=>!run.released&&!stoppedReviewers.has(run.id)))throw Error('A run started during the move; refresh before retrying');
      for(const stoppedReviewer of this.store.runs(current.id).filter(run=>run.role==='reviewer'&&!run.completion&&!run.released&&stoppedReviewers.has(run.id))){
      // A reviewer whose live turn an owner verb cancelled — this move, a re-plan
      // of it, or an earlier stop — is stopped, not replaced: it keeps no
      // credential and no #531 replacement claim. Read from the durable record.
      if(this.engine.ownerCancelledRun(current.id,stoppedReviewer.id)){
        this.store.deleteCredential(stoppedReviewer.id);
        this.store.putRun({...stoppedReviewer,status:'superseded',released:true,active:false});
        this.store.event(current.id,'move_review_reviewer_settled',`${stoppedReviewer.id} (turn cancelled): ${input.reason}`.slice(0,2000));
      }else{
        // `replacedAt` records why the run was released; its credential is revoked
        // with the release like every run's (task 1005).
        const ended=stoppedReviewer.retainedAgentClosedAt!==undefined;
        this.store.putRun({...stoppedReviewer,status:'superseded',released:ended,active:false,...(ended?{}:{replacedAt:now()})});
        this.store.event(current.id,'move_review_reviewer_settled',`${stoppedReviewer.id}: ${input.reason}`.slice(0,2000));
      }
      }
      const settledTask=this.store.task(task.id);
      const review=settledTask.resolution.review;
      const supersession=review?{id:randomUUID(),at:now(),reason:input.reason,reviewRunId:review.runId,reviewId:review.reviewId??null,
        reviewCommentId:review.reviewCommentId??null,head:review.head??settledTask.prHead??pr.head,review,verification:null,
        mechanicalVerification:settledTask.resolution.mechanicalVerification}:null;
      const note=`Superseded by owner move to review at ${pr.head}: ${input.reason}`;
      const recovery=settledTask.resolution.recovery&&settledTask.resolution.recovery.status!=='resolved'
        ?{...settledTask.resolution.recovery,status:'resolved' as const,summary:`${note}; original: ${settledTask.resolution.recovery.summary}`}:settledTask.resolution.recovery;
      const incident=settledTask.resolution.incident&&settledTask.resolution.incident.status!=='resolved'
        ?{...settledTask.resolution.incident,status:'resolved' as const,detail:`${note}; original: ${settledTask.resolution.incident.detail}`,updatedAt:now()}:settledTask.resolution.incident;
      const requests=input.reviewer?{...settledTask.profileRequests,reviewer:{profileId:input.reviewer.profileId,reason:input.reviewer.reason.trim(),required:true}}:settledTask.profileRequests;
      if(evidence)this.store.event(task.id,'move_review_pr_bound',
        `PR #${evidence.prNumber} at ${pr.head} from the ready result ${evidence.eventId} of run ${evidence.runId}: ${input.reason}`.slice(0,2000));
      // Spec 057 (task 553): keep the retained reviewer on a responsible task
      // unless fresh was asked for or the retained reviewer is closed or
      // unavailable. A kept binding is still validated at selection: a stale
      // one falls back to a fresh reviewer there, so keeping never forces a
      // reader that cannot continue.
      const retainedAgent = settledTask.resolution.reviewerAgentId;
      const retainedProfile = settledTask.resolution.reviewerProfile;
      const lastRetainedRun = retainedAgent
        ? this.store.runs(settledTask.id).filter(run => run.role === 'reviewer' && run.agentId === retainedAgent).at(-1) ?? null
        : null;
      const retainedClosed = Boolean(lastRetainedRun?.retainedAgentClosedAt || lastRetainedRun?.reviewBudgetExhaustedAt
        || (retainedAgent && observedRetained?.id === retainedAgent && retainedClosedAtObserve));
      const retainedUnavailable = !retainedAgent || !retainedProfile
        || Boolean(this.resolution.retainedProfileIssue(retainedProfile))
        || Boolean(this.resolution.signoffIssue(settledTask, retainedProfile, 'reviewer'))
        || this.resolution.authorAgentIds(settledTask).has(retainedAgent);
      const keepReviewer = keepRetainedReviewer(freshAsked, retainedClosed, retainedUnavailable);
      this.store.update(settledTask.id,{prHead:pr.head,prUrl:pr.url,...(evidence?{resumePrNumber:evidence.prNumber}:{}),profileRequests:requests,phase:'awaiting_review',
        reason: keepReviewer
          ? `Owner moved the task to review at ${pr.head} with the retained reviewer ${retainedAgent}`
          : `Owner moved the task to a fresh review at ${pr.head}`,
        resolution:{...settledTask.resolution,currentRunId:null,stop:null,
          ...(keepReviewer ? {} : {reviewerAgentId:null,reviewerProfile:null}),review:null,
          mechanicalVerification:null,integrationTurn:null,pendingReviewReason:input.reason,pendingRevisionCause:null,pendingWorkerInstruction:null,
          attention:false,recoveryActive:false,recovery,incident,
          reviewSupersessions:supersession?[...settledTask.resolution.reviewSupersessions,supersession]:settledTask.resolution.reviewSupersessions}},
        input.caller?'move_review_requested':'owner_control',JSON.stringify({verb:'move',to:'review',head:pr.head,phaseBefore:settledTask.phase,reason:input.reason,
          ...(keepReviewer ? {retainedReviewer:retainedAgent} : {fresh:true}),
          incidentId:current.resolution.incident?.id??null,recoveryId:current.resolution.recovery?.id??null,...(evidence?{boundPr:evidence}:{})}));
      // The move itself supersedes the accepted review, an answered incident and
      // recovery with their original detail; the registry helper settles what the
      // move does not carry: an eligible or reserved mechanical carry, a pending
      // checkpoint continuation intent and pending attention notices. History
      // kept. Settled inside the transaction, so a refused move changes nothing.
      settleSupersededFencesInTx(this.store,task.id,`move review: ${input.reason}`,now(),this.engine.coordinatorActionRunId.getStore());
      return this.store.task(task.id);
      }),`task:${task.id}`);
      // A reviewer run the move could not release, or a busy participant the
      // dispatch lease polls, still owns the launch: name it, with the rule
      // keeping it and what releases it, instead of reporting a move to review
      // that started no reader (nucleus#1100).
      await this.nameLaunchFence(task.id, settled.reason, input.reason);
      return this.store.task(settled.id);
    },`task:${task.id}`);
  }

  /**
   * Say in the reply that the move left the task waiting on a run it could not
   * release, or on a busy participant the dispatch lease polls, and what
   * releases each. `next` reads the same recorded stop, so the owner never sees
   * plain success with no reader launched.
   */
  async nameLaunchFence(taskId: string, reason: string, why: string): Promise<void> {
    const current = this.store.task(taskId);
    const fence = unreleasedLaunchFence(this.store, current, "reviewer");
    if (fence) {
      this.resolution.waiting(current, `${reason}, but the launch waits on ${fence}: ${why}`, "lifecycle");
      return;
    }
    // A finished run's recorded completion keeps this read quiet: finished work
    // is not a live participant (nucleus#1100).
    const decline = await this.resolution.leaseDeclineReason(this.store.task(taskId));
    if (decline) this.resolution.waiting(this.store.task(taskId), `${reason}, but the launch waits on ${decline}: ${why}`, "lifecycle");
  }

  /**
   * A proof-only qualification with a settled receipt and no verdict reviews
   * the receipt. The receipt is the subject, so this path never verifies a PR
   * and starts no executor.
   */
  async moveProofOnlyReceiptToReview(input:{taskId:string;version:number;reason:string;reviewer?:{profileId:string;reason:string};caller?:string;prNumber?:number;fresh?:boolean},operationId?:string):Promise<Task>{
    const task=this.store.task(input.taskId);
    const commit=task.proofOnly!.commit;
    if(input.prNumber!==undefined)throw Error('A proof-only receipt review has no PR');
    const reviewRunsBefore=this.store.runs(task.id);
    const finished=await this.engine.collectVerbFinishedRuns(task.id,run=>run.role==='reviewer'&&!run.completion,{displace:true});
    if(finished.fenced.length)throw new DurableFenceRefusal(this.engine.displaceRefusal(finished.fenced[0]!));
    const displaced=[...finished.settleable,...finished.live];
    const settling=new Set(displaced.map(run=>run.id));
    const candidates=this.store.runs(task.id).filter(run=>!run.released&&!settling.has(run.id));
    const stoppedReviewers=new Set<string>();
    const liveReviewers:Run[]=[];
    for(const run of candidates) if(run.role==='reviewer'&&!run.completion){
      const why=this.engine.runDurableFence(this.store.task(task.id),run);
      if(why)throw new DurableFenceRefusal(this.engine.displaceRefusal({run,why}));
      if(await this.engine.observedRunLiveness(run)===false)stoppedReviewers.add(run.id); else liveReviewers.push(run);
    }
    const live=candidates.find(run=>!stoppedReviewers.has(run.id)&&!liveReviewers.includes(run));
    if(live)throw new DurableFenceRefusal(this.engine.displaceRefusal({run:live,why:'its state changed during the move'}));
    if(input.reviewer){
      this.engine.requireProfileCatalog();
      validateNamedProfile(input.reviewer.profileId,'reviewer',task.scope,this.engine.profiles,this.store.pool(),input.reviewer.reason.trim(),task.thinkingOptionId);
      this.engine.requireAvailableGroup(input.reviewer.profileId);
    }
    if(finished.live.length||liveReviewers.length)this.engine.assertUnchangedBeforeCancel(task.id,input.version,reviewRunsBefore);
    await this.engine.cancelDisplacedTurns(task.id,[...finished.live,...liveReviewers],'move review');
    for(const run of liveReviewers)stoppedReviewers.add(run.id);
    const freshAsked=input.fresh===true;
    const observedRetained=!freshAsked&&task.resolution.reviewerAgentId
      ? await this.engine.host.observe(task.resolution.reviewerAgentId).catch(()=>null)
      : null;
    const retainedClosedAtObserve=Boolean(observedRetained
      && observedRetained.id===task.resolution.reviewerAgentId && observedRetained.status==='closed');
    return this.engine.control(async()=>{
      const settled=await this.engine.control(()=>this.store.transaction(()=>{
      const current=this.store.task(task.id);
      this.engine.requireOwnerControlCurrent(current,input.version,'Task changed; refresh before retrying');
      if(!proofOnlyReceiptAwaitingReview(current))throw Error('The proof-only receipt is no longer waiting for review');
      this.engine.releaseDisplacedRunsInTx(task.id,displaced.map(run=>run.id),`move review: ${input.reason}`);
      if(this.store.runs(current.id).some(run=>!run.released&&!stoppedReviewers.has(run.id)))throw Error('A run started during the move; refresh before retrying');
      const stoppedReviewer=this.store.runs(current.id).find(run=>run.role==='reviewer'&&!run.completion&&!run.released&&stoppedReviewers.has(run.id));
      if(stoppedReviewer&&this.engine.ownerCancelledRun(current.id,stoppedReviewer.id)){
        this.store.deleteCredential(stoppedReviewer.id);
        this.store.putRun({...stoppedReviewer,status:'superseded',released:true,active:false});
        this.store.event(current.id,'move_review_reviewer_settled',`${stoppedReviewer.id} (turn cancelled): ${input.reason}`.slice(0,2000));
      }else if(stoppedReviewer){
        const ended=stoppedReviewer.retainedAgentClosedAt!==undefined;
        this.store.putRun({...stoppedReviewer,status:'superseded',released:ended,active:false,...(ended?{}:{replacedAt:now()})});
        this.store.event(current.id,'move_review_reviewer_settled',`${stoppedReviewer.id}: ${input.reason}`.slice(0,2000));
      }
      const settledTask=this.store.task(task.id);
      const review=settledTask.resolution.review;
      const supersession=review?{id:randomUUID(),at:now(),reason:input.reason,reviewRunId:review.runId,reviewId:review.reviewId??null,
        reviewCommentId:review.reviewCommentId??null,head:review.head??commit,review,verification:null,
        mechanicalVerification:settledTask.resolution.mechanicalVerification}:null;
      const note=`Superseded by owner move to review at ${commit}: ${input.reason}`;
      const recovery=settledTask.resolution.recovery&&settledTask.resolution.recovery.status!=='resolved'
        ?{...settledTask.resolution.recovery,status:'resolved' as const,summary:`${note}; original: ${settledTask.resolution.recovery.summary}`}:settledTask.resolution.recovery;
      const incident=settledTask.resolution.incident&&settledTask.resolution.incident.status!=='resolved'
        ?{...settledTask.resolution.incident,status:'resolved' as const,detail:`${note}; original: ${settledTask.resolution.incident.detail}`,updatedAt:now()}:settledTask.resolution.incident;
      const requests=input.reviewer?{...settledTask.profileRequests,reviewer:{profileId:input.reviewer.profileId,reason:input.reviewer.reason.trim(),required:true}}:settledTask.profileRequests;
      const retainedAgent=settledTask.resolution.reviewerAgentId;
      const retainedProfile=settledTask.resolution.reviewerProfile;
      const lastRetainedRun=retainedAgent
        ? this.store.runs(settledTask.id).filter(run=>run.role==='reviewer'&&run.agentId===retainedAgent).at(-1)??null
        : null;
      const retainedClosed=Boolean(lastRetainedRun?.retainedAgentClosedAt||lastRetainedRun?.reviewBudgetExhaustedAt
        ||(retainedAgent&&observedRetained?.id===retainedAgent&&retainedClosedAtObserve));
      const retainedUnavailable=!retainedAgent||!retainedProfile
        ||Boolean(this.resolution.retainedProfileIssue(retainedProfile))
        ||Boolean(this.resolution.signoffIssue(settledTask,retainedProfile,'reviewer'))
        ||this.resolution.authorAgentIds(settledTask).has(retainedAgent);
      const keepReviewer=keepRetainedReviewer(freshAsked,retainedClosed,retainedUnavailable);
      this.store.update(settledTask.id,{profileRequests:requests,phase:'awaiting_review',
        reason: keepReviewer
          ? `Owner moved the proof-only receipt to review at ${commit} with the retained reviewer ${retainedAgent}`
          : `Owner moved the proof-only receipt to a fresh review at ${commit}`,
        resolution:{...settledTask.resolution,currentRunId:null,stop:null,
          ...(keepReviewer ? {} : {reviewerAgentId:null,reviewerProfile:null}),review:null,
          mechanicalVerification:null,integrationTurn:null,pendingReviewReason:input.reason,pendingRevisionCause:null,pendingWorkerInstruction:null,
          attention:false,recoveryActive:false,recovery,incident,
          reviewSupersessions:supersession?[...settledTask.resolution.reviewSupersessions,supersession]:settledTask.resolution.reviewSupersessions}},
        input.caller?'move_review_requested':'owner_control',JSON.stringify({verb:'move',to:'review',head:commit,phaseBefore:settledTask.phase,reason:input.reason,
          ...(keepReviewer ? {retainedReviewer:retainedAgent} : {fresh:true}),
          incidentId:current.resolution.incident?.id??null,recoveryId:current.resolution.recovery?.id??null}));
      settleSupersededFencesInTx(this.store,task.id,`move review: ${input.reason}`,now(),this.engine.coordinatorActionRunId.getStore());
      return this.store.task(task.id);
      }),`task:${task.id}`);
      // A reviewer run the move could not release, or a busy participant the
      // dispatch lease polls, still owns the launch: name it, with the rule
      // keeping it and what releases it, instead of reporting a move to review
      // that started no reader (nucleus#1100).
      await this.nameLaunchFence(task.id, settled.reason, input.reason);
      return this.store.task(settled.id);
    },`task:${task.id}`);
  }

  /** An owner continuation refuses an open prerequisite wait and clears a released one in its own transaction. */
  resumeReleasedPrerequisiteWait(taskId:string):void{
    const task=this.store.task(taskId);
    if(!task.prerequisiteWait)return;
    if(!task.prerequisiteWait.releasedAt)throw Error(RETAINED_PREREQUISITE_REFUSAL);
    this.store.update(task.id,{prerequisiteWait:null},'prerequisite_wait_resumed','Owner explicitly resumed the task after the prerequisite notice');
  }

  /**
   * A recorded workspace can be gone while its branch is still on origin. The
   * owner verbs that continue a worker (`move to=work`, `restart role=worker`)
   * re-create the worktree from that published branch before they touch the
   * retained thread: the task, its PR and its approval stay, the runs that lived
   * in the lost workspace settle as superseded history, and the role starts on a
   * fresh thread because a thread's cwd and binding belong to its old workspace
   * (nucleus#964, nucleus#974). Returns the same task when its workspace is
   * available, so every other move keeps its current path.
   */
  async recreateLostWorkspace(task: Task, reason: string): Promise<Task> {
    const available = this.adapter.workspaceAvailable;
    if (!task.workspaceId || !available || await available(task.workspaceId)) return task;
    if (!this.adapter.recoverTaskWorkspace)
      throw Error('The recorded task workspace is gone and this host cannot re-create a worktree; restore the workspace before continuing');
    const blocking = blockingRecoveryEffectsRefusal(this.store, task);
    if (blocking) throw new DurableFenceRefusal(blocking);
    // The worker resumes from its published branch, so the recovery reads the
    // branch on origin rather than the accepted PR head. A workspace whose
    // registration survives but whose directory is gone is re-created, never
    // rebound: the recovery proves a live clean checkout at that head.
    const workspace = await this.adapter.recoverTaskWorkspace(task, { target: 'branch' });
    const lost = task.workspaceId;
    const apply = () => {
      const current = this.store.task(task.id);
      for (const run of this.store.runs(task.id).filter(run => !run.released && run.workspaceId === lost)) {
        const why = this.engine.runDurableFence(current, run);
        if (why) throw new DurableFenceRefusal(this.engine.displaceRefusal({ run, why }));
        this.store.deleteCredential(run.id);
        this.store.putRun({ ...run, status: 'superseded', released: true, active: false });
        this.store.event(current.id, 'workspace_worker_retired', `${run.role} ${run.id}: recorded workspace ${lost} was gone; the source was re-created at ${workspace.directory}`);
      }
      const retired = current.agentId && current.profile
        ? [...current.retiredWorkers, { agentId: current.agentId, runId: current.runId ?? '', profile: current.profile,
            reason: `Recorded workspace ${lost} was gone; re-created the worktree from the branch on origin. ${reason}`.slice(0, 2000) }]
        : current.retiredWorkers;
      return this.store.update(current.id, {
        workspaceId: workspace.id, directory: workspace.directory, agentId: null, runId: null, agentIntent: false,
        agentActive: false, lastAgentStatus: null, lastObservedAt: null, idleSince: null, transientProviderRetry: undefined,
        retiredWorkers: retired,
        resolution: { ...current.resolution, currentRunId: null, reviewerAgentId: null, reviewerProfile: null, stalledTurnStop: null },
      }, 'task_workspace_recreated', `${lost} → ${workspace.id} at ${workspace.directory}; ${reason}`.slice(0, 2000));
    };
    return this.store.db.isTransaction ? apply() : this.store.transaction(apply);
  }

  /**
   * Spec 050 `move to=work`: return the task to its author for a revision with
   * the instruction. A checkpointed or stopped reviewer run yields and is
   * superseded with history kept; a live turn refuses. A retained author takes
   * the ordinary revision turn; a gone author is replaced by a fresh one on the
   * worker route through the existing replacement machinery.
   */
  async moveToWork(input:{taskId:string;version:number;reason:string;instruction?:string;caller?:string;restart?:{afterSettlement:(settled:Task)=>Task;afterRevision:(revised:Task)=>Task}}):Promise<Task>{
    let task=this.store.task(input.taskId);
    if(task.removedAt)throw Error(REMOVED_TASK_REFUSAL);
    this.engine.requireOwnerControlCurrent(task,input.version,'Task changed; refresh before retrying');
    const stateRefusal = moveStateRefusal(task, "work");
    if(stateRefusal)throw Error(stateRefusal);
    // Spec 050 (#3569): finished runs settle by observation before the run
    // fence — including a completed reviewer run, whose verdict the task
    // already carries; one that cannot settle refuses here, with its own
    // reason and nothing written.
    if(!task.agentId&&!task.agentIntent&&!(task.profile&&task.workspaceId))throw Error(MOVE_WORK_AUTHOR_REFUSAL);
    if(operatorReplacementPending(task) && task.phase === 'dispatching' && !task.agentId && task.agentIntent)
      throw Error(MOVE_WORK_REPLACEMENT_REFUSAL);
    if(task.prerequisiteWait&&!task.prerequisiteWait.releasedAt)throw Error(RETAINED_PREREQUISITE_REFUSAL);
    // A lost workspace is re-created from the branch on origin before the move
    // reads the retained worker: the task, PR and approval stay, and the author
    // continues on a fresh thread in the recovered worktree.
    task=await this.recreateLostWorkspace(task,`move to work: ${input.reason}`);
    if(!task.agentId&&!currentRouteProfile(task,'worker')&&!task.profile)throw Error('Starting a fresh author requires the worker route or the retained profile');
    // A callback landing while the runs are observed refuses below; cancelling a
    // turn writes only events, so it never trips this guard.
    const runsBeforeMove=this.store.runs(task.id);
    // Round 4: every run in the way is displaced — a busy turn is cancelled
    // after the checks above, an idle one settles — and only a durable side
    // effect refuses.
    const finished=await this.engine.collectVerbFinishedRuns(task.id,run=>run.role==='reviewer'&&!run.completion,{displace:true});
    if(finished.fenced.length)throw new DurableFenceRefusal(this.engine.displaceRefusal(finished.fenced[0]!));
    const displaced=[...finished.settleable,...finished.live];
    const settling=new Set(displaced.map(run=>run.id));
    const candidates=this.store.runs(task.id).filter(run=>!run.released&&!settling.has(run.id));
    // Observed liveness (Spec 050): a reviewer run whose agent is observed idle
    // yields to the move whatever its stored `active` flag says; a live reviewer
    // turn is cancelled first and then yields the same way.
    const stoppedReviewers=new Set<string>();
    const liveReviewers:Run[]=[];
    for(const run of candidates) if(run.role==='reviewer'&&!run.completion){
      const why=this.engine.runDurableFence(this.store.task(task.id),run);
      if(why)throw new DurableFenceRefusal(this.engine.displaceRefusal({run,why}));
      if(await this.engine.observedRunLiveness(run)===false)stoppedReviewers.add(run.id); else liveReviewers.push(run);
    }
    const live=candidates.find(run=>!stoppedReviewers.has(run.id)&&!liveReviewers.includes(run));
    if(live)throw new DurableFenceRefusal(this.engine.displaceRefusal({run:live,why:'its state changed during the move'}));
    // Project-d #117 (Tom, 2026-10-23): a retained author's revision on a PR the
    // task knows only from a reported completion binds that PR in the accepting
    // transaction, verified as the revision continuation verifies it. A failed
    // proof refuses here, before any turn is cancelled or anything is written.
    let continuedPr:ContinuedPrBinding|null=null;
    let foreignCompletion: string | null = null;
    if(task.agentId){
      try{continuedPr=await this.resolution.verifyContinuedPr(task);}
      catch(error){
        if (error instanceof ForeignPrIdentity && task.completion && evidenceOnlyPr(task)) foreignCompletion = task.completion.eventId;
        else throw Error(`Move to work cannot bind PR #${evidenceOnlyPr(task)}, which the task knows only from its ${task.completion?.status} report: ${error instanceof Error?error.message:String(error)}. Nothing was written`);
      }
    }
    this.engine.assertUnchangedBeforeCancel(task.id,task.version,runsBeforeMove);
    await this.engine.cancelDisplacedTurns(task.id,[...finished.live,...liveReviewers],'move work');
    for(const run of liveReviewers)stoppedReviewers.add(run.id);
    const instruction=input.instruction?.trim()
      ||'Continue the existing task under its current approved instruction source and within its approved scope.';
    // Spec 050 atomic verbs: the fences the move supersedes — open incident,
    // escalated recovery, reminders, carry and checkpoint intent, whatever the
    // attention flag said — settle inside the guarded transaction below, after
    // every check that can refuse, so a refused move changes nothing. History
    // kept. Task and run identities captured before observation must still match
    // when the move commits; an intervening callback or owner edit refuses.
    const expected=task.version;
    return this.engine.control(async()=>{
      const current=this.store.task(task.id);
      this.engine.requireOwnerControlCurrent(current,expected,'Task or run changed; refresh before retrying');
      if(!runsUnchangedSince(runsBeforeMove,this.store.runs(task.id)))throw Error('Task or run changed; refresh before retrying');
      // The fresh-author refusal derives from the recorded route and profile,
      // which the settlement never touches: check it before anything is written,
      // so a refused move changes nothing.
      if(!current.agentId){
        const routeProfileId=currentRouteProfile(current,'worker');
        if(!routeProfileId&&!current.profile)throw Error('Starting a fresh author requires the worker route or the retained profile');
      }
      // Spec 050 atomic verbs: the settlement commits inside the same
      // transaction as the action it enables — a refused retry or a drifted
      // version rolls the settlement back with it.
      const settleAndCheck=()=>{
        const latest=this.store.task(task.id);
        this.engine.requireOwnerControlCurrent(latest,expected,'Task changed; refresh before retrying');
        this.engine.settleVerbFences(task.id,{detail:`move work: ${input.reason}`,runIds:[],displacedRunIds:displaced.map(run=>run.id)});
        this.engine.resumeReleasedPrerequisiteWait(task.id);
        if(this.store.runs(latest.id).some(run=>!run.released&&!stoppedReviewers.has(run.id)))throw Error('A run started during the move; refresh before retrying');
        const stoppedReviewer=this.store.runs(latest.id).find(run=>run.role==='reviewer'&&!run.completion&&!run.released&&stoppedReviewers.has(run.id));
        if(stoppedReviewer){
          this.store.deleteCredential(stoppedReviewer.id);
          this.store.putRun({...stoppedReviewer,status:'superseded',released:true,active:false});
          this.store.event(latest.id,'move_work_reviewer_settled',`${stoppedReviewer.id}: ${input.reason}`.slice(0,2000));
          this.store.update(latest.id,{resolution:{...latest.resolution,currentRunId:null,reviewerAgentId:null,reviewerProfile:null}},'move_work_reviewer_settled',stoppedReviewer.id);
        }
        return this.store.task(task.id);
      };
      if(current.agentId){
        return this.store.transaction(()=>{
          let settledTask=settleAndCheck();
          if(input.restart)settledTask=input.restart.afterSettlement(settledTask);
          if (foreignCompletion) {
            if (settledTask.completion?.eventId !== foreignCompletion) throw Error('Reported PR evidence changed during the move');
            settledTask = this.store.update(task.id, { completion: null }, 'foreign_completion_cleared', JSON.stringify({eventId: foreignCompletion, reason: input.reason}));
          }
          if(continuedPr&&!this.resolution.bindContinuedPrInTx(task.id,continuedPr,`move work: ${input.reason}`))
            throw Error('The task PR evidence changed during the move; refresh before retrying');
          // No instruction keeps the pending one or the review findings, as revise did.
          const result=settledTask.resolution.currentRunId ? this.store.run(settledTask.resolution.currentRunId)?.completion : null;
          const findings=result?.status==='changes_required' ? result.reviewText || result.summary : undefined;
          let revised=this.resolution.retry(this.store.task(task.id),true,input.instruction?.trim()||settledTask.resolution.pendingWorkerInstruction||findings||undefined,true,false,!taskHasPr(settledTask));
          if (settledTask.completion?.status === 'report_ready') {
            const report = settledTask.completion;
            this.store.event(task.id, 'report_returned_to_work', JSON.stringify({ eventId: report.eventId, summary: report.summary, artifact: report.artifact,
              instruction: revised.resolution.pendingWorkerInstruction ?? input.instruction?.trim() ?? '' }));
            revised = this.store.update(task.id, { completion: null }, 'report_ready_completion_cleared', report.eventId);
          }
          return input.restart?input.restart.afterRevision(revised):revised;
        });
      }
      // The author is gone: start a fresh author on the worker route through the
      // existing replacement machinery; selection reads `replacementProfile`.
      // The route/profile refusal already fired before the settlement above.
      return this.store.transaction(()=>{
        const settledTask=settleAndCheck();
        if (settledTask.completion?.status === 'report_ready') {
          const report = settledTask.completion;
          this.store.event(task.id, 'report_returned_to_work', JSON.stringify({ eventId: report.eventId, summary: report.summary, artifact: report.artifact, instruction }));
        }
        const routeProfileId=currentRouteProfile(settledTask,'worker');
        const latest=this.store.task(task.id);
        if(latest.version!==settledTask.version)throw Error('Task changed during the move; refresh before retrying');
        const failoverReason=`${OPERATOR_WORKER_REMAP_REASON}. Continue the existing task: ${instruction}`.slice(0,2000);
        if(routeProfileId&&settledTask.profileRequests?.worker?.ownerRoute)
          this.store.event(task.id,'worker_route_honoured',`move to=work selected pending worker route ${routeProfileId}`);
        return this.store.update(latest.id,{
          phase:'changes_requested', ...(settledTask.completion?.status === 'report_ready' ? { completion: null } : {}),
          reason:'Owner moved the task to a fresh author revision on the worker route',
          failoverReason,
          replacementProfile:{profileId:routeProfileId??latest.profile!.id,reason:input.reason.slice(0,4000)},
          resolution:{...latest.resolution,currentRunId:null,attention:false,recoveryActive:false,recoveryAttempts:0,
            pendingWorkerInstruction:instruction,...(taskHasPr(latest)?{}:{prePrResumeInstruction:instruction})},
        },input.caller?'move_work_requested':'owner_control',JSON.stringify({verb:'move',to:'work',phaseBefore:settledTask.phase,reason:input.reason}));
      });
    },`task:${task.id}`);
  }

  /**
   * Spec 050 `move to=merge`: enter the normal integration turn, pre-merge
   * hooks and merge path. Allowed only with an accepted review at the exact
   * current PR head, re-verified at the remote before anything changes — or,
   * since 2026-10-17, with an explicit qualified owner acceptance: the task
   * project's authorized owner (or an operator ruling relayed with its note)
   * records one durable acceptance over an authentic released reviewer verdict
   * at the exact current head, and the ordinary verification, merge and
   * closeout gates read it without any fabricated reviewer pass. Since
   * 2026-10-20 (Tom's "Approve" on lead 87115b71) the same owner path also
   * records an explicit operator source acceptance of the exact published
   * source head AS IS when no review evidence binds that head — an interrupted
   * or unfinished reviewer, an unpublished verdict, or a head a docs-only
   * resolution moved after the verdict. The record binds actor, authority,
   * ruling, head, qualification and the concrete missing evidence; it never
   * invents a verdict or rewrites one as PASS, and a later head invalidates it.
   * Every merge hold and every other gate (required checks, pre-merge hooks,
   * forge identity) stays real, and a clean advance of the integration base is
   * not drift: the ordinary verification path proves the merge gates, so no
   * exact-base equality is checked here.
   */
  async moveToMerge(input:{taskId:string;version:number;reason:string;caller?:string;qualification?:string;head?:string;relayed?:boolean;delegated?:boolean;relayNote?:string}):Promise<Task>{
    const task=this.store.task(input.taskId);
    if(task.removedAt)throw Error(REMOVED_TASK_REFUSAL);
    this.engine.requireOwnerControlCurrent(task,input.version,'Task changed; refresh before retrying');
    const stateRefusal = moveStateRefusal(task, "merge");
    if(stateRefusal)throw Error(stateRefusal);
    const review=task.resolution.review;
    const qualification=input.qualification?.trim();
    const accepting=Boolean(qualification);
    if(input.head&&!accepting)throw Error('A head can be named only with an owner acceptance (qualification); a reviewed merge needs an exact-head ready review');
    // Papercut 209406f4: an owner acceptance may name the exact PR head it accepts.
    // Every gate below is judged at that head, never the stored one: an old-head
    // verdict, ready or not, is history and never carries over.
    const acceptedHead=input.head??task.prHead;
    const adopting=Boolean(input.head)&&input.head!==task.prHead;
    const prospective=(t:Task):Task=>adopting?{...t,prHead:acceptedHead}:t;
    if(!readyReviewAtHead(task, acceptedHead)){
      // The ordinary gate is exact-head `ready_to_merge`. With an explicit
      // qualification the caller states acceptance intent, and Queue derives the
      // task, PR, head and — when a current-head verdict exists — the review
      // identities under the shared rule; otherwise the disposition is an
      // explicit operator source acceptance of the exact published head.
      if(!accepting)throw Error('Move to merge requires an accepted review at the current PR head');
      const eligible=qualifiedAcceptanceEligibility(prospective(task),this.store.runs(task.id));
      if(!eligible.available)throw Error(eligible.refusal);
    } else if (accepting) {
      throw Error(MOVE_MERGE_ACCEPTANCE_REFUSAL);
    }
    const authority=accepting?(input.delegated?this.engine.assertDelegatedAuthority(input.caller,input.relayNote,'Qualified owner acceptance'):this.engine.assertOwnerAuthority(input.caller,input.relayed,input.relayNote)):null;
    // Re-verify the canonical source before anything is displaced or written: the
    // head the move enters verification with is GitHub's own open PR head, and it
    // must be the head named, or with none named, the stored one.
    const mergeRunsBefore=this.store.runs(task.id);
    const observed=await this.adapter.verifyPr(task,taskPrNumber(task));
    this.engine.assertUnchangedBeforeCancel(task.id,input.version,mergeRunsBefore);
    if(input.head&&observed.head!==input.head)throw Error(`The current PR head ${observed.head} differs from the head you accept (${input.head}); refresh before retrying`);
    if(!input.head&&observed.head!==task.prHead)
      throw Error(`The current PR head ${observed.head} differs from the task's recorded head ${task.prHead}; pass head=${observed.head} with an owner acceptance to accept that exact head, or move to review for a review of it`);
    // Spec 050 (#3569): finished runs of other roles settle by observation
    // before the run fence; one that cannot settle refuses here, with its own
    // reason and nothing written.
    // Round 4: a move applies while paused; only dispatch waits for unpause.
    // Round 4: every run in the way is displaced; only a durable side effect refuses.
    const finished=await this.engine.collectVerbFinishedRuns(task.id,()=>false,{displace:true});
    if(finished.fenced.length)throw new DurableFenceRefusal(this.engine.displaceRefusal(finished.fenced[0]!));
    const displaced=[...finished.settleable,...finished.live];
    this.engine.assertUnchangedBeforeCancel(task.id,input.version,mergeRunsBefore);
    await this.engine.cancelDisplacedTurns(task.id,finished.live,'move merge');
    // Keep the admitted task and run facts across every remote read and stop.
    // The move's own fence settlement happens only in the guarded transaction;
    // unrelated writes during earlier waits must not become a fresh baseline.
    return this.engine.control(async()=>{
      this.engine.assertUnchangedBeforeCancel(task.id,input.version,mergeRunsBefore);
      // A fresh observation after the waits and the cancellation: a displaced turn
      // may have pushed before it stopped, and no network call runs inside the
      // commit transaction below.
      const pr=await this.adapter.verifyPr(task,taskPrNumber(task));
      if(pr.head!==acceptedHead)throw Error(`The current PR head ${pr.head} differs from the accepted head ${acceptedHead}; refresh before retrying`);
      return this.store.transaction(()=>{
      const current=this.store.task(task.id);
      this.engine.assertUnchangedBeforeCancel(task.id,input.version,mergeRunsBefore);
      // The settlement records a recovery episode's pending accepted action as
      // not applied on the resolved episode; the re-read carries that record
      // through the move's own update below.
      this.engine.settleVerbFences(task.id,{detail:`move merge: ${input.reason}`,runIds:[],displacedRunIds:displaced.map(run=>run.id)});
      if(this.store.runs(current.id).some(run=>!run.released && run.id !== this.engine.coordinatorActionRunId.getStore()))throw Error('A run started during the move; refresh before retrying');
      const stored=this.store.task(task.id);
      // A head is adopted only from the stored head the move read, and only with
      // the acceptance that names it: a refused acceptance adopts nothing.
      if(adopting&&stored.prHead!==task.prHead)throw Error('The task head changed during the move; refresh before retrying');
      const settledTask=prospective(stored);
      const settledEligibility=accepting?qualifiedAcceptanceEligibility(settledTask,this.store.runs(settledTask.id)):null;
      const accepted=settledTask.resolution.review;
      // Accepting, the shared rule re-derived on the settled state is the guard:
      // it binds the exact settled head for either disposition kind. Otherwise
      // the ordinary gate stays the exact-head ready review.
      if(settledTask.prHead!==pr.head
        ||(accepting?settledEligibility!.available!==true
          :!readyReviewAtHead(settledTask)))throw Error('The accepted review or PR head changed during the move; refresh before retrying');
      const sequence=settledTask.resolution.integrationTurn?.sequence??this.store.nextIntegrationSequence(settledTask.repoPath);
      // The one durable owner decision beside the immutable verdict: task, PR,
      // head and — for a reviewed acceptance — review identities, the attributed
      // caller, the authority it proved and the disclosed qualification. An
      // operator source acceptance binds the same head with no review identity
      // and records the concrete missing evidence instead. Recording never
      // touches the verdict, its publication, any hold or any other gate.
      let acceptance: OwnerAcceptanceRecord|null=null;
      if(accepting&&settledEligibility!.available){
        const common={
          at:now(), head:pr.head, prNumber:taskPrNumber(settledTask),
          actor:{agentId:input.caller!,role:authority!.role},
          authority:{kind:authority!.kind,note:authority!.note},
          reason:input.reason.trim().slice(0,4000),qualification:qualification!.slice(0,4000),
        };
        if(settledEligibility!.acceptance==='reviewed'){
          // The acceptance binds only a reviewer verdict; the eligibility rule
          // above proved it, and this narrow guard keeps the record's type exact.
          if(!accepted||accepted.status!=='changes_required')throw Error('The recorded review changed during the move; refresh before retrying');
          acceptance={...common,kind:'reviewed',missingEvidence:null,
            review:{runId:accepted.runId,eventId:accepted.eventId,head:settledTask.prHead,status:accepted.status,
              reviewId:accepted.reviewId??null,reviewCommentId:accepted.reviewCommentId??null}};
        } else {
          acceptance={...common,kind:'operator_source',review:null,
            missingEvidence:settledEligibility!.missingEvidence.slice(0,4000)};
        }
      }
      if(acceptance) this.store.event(task.id,'owner_acceptance',JSON.stringify({taskId:task.id,kind:acceptance.kind,prNumber:acceptance.prNumber,head:acceptance.head,
        ...(acceptance.kind==='operator_source'?{missingEvidence:acceptance.missingEvidence}:{}),
        review:acceptance.review,actor:acceptance.actor,authority:acceptance.authority,reason:acceptance.reason,qualification:acceptance.qualification}).slice(0,4000));
      if(adopting)this.store.event(task.id,'owner_head_adopted',JSON.stringify({from:task.prHead,to:pr.head,caller:input.caller??null,reason:input.reason.trim().slice(0,400)}));
      // A planner or operator that settles the exact proof-wait head and moves
      // it to merge has resolved this specific Queue-created hold. Keep every
      // other merge hold under its existing owner's control.
      const proofHold=holdsOf(settledTask).merge;
      const proofHoldPrefix=`Proofs Queue cannot run, left for the planner or operator at ${pr.head}:`;
      const settlesProofHold=Boolean(proofHold&&proofHold.reason.startsWith(proofHoldPrefix));
      this.store.update(settledTask.id,{
        ...(adopting?{prHead:pr.head}:{}),
        ...(settlesProofHold?releasePatch(settledTask,'merge'):{}),
        phase:'verifying',
        reason:(acceptance
          ?(acceptance.kind==='operator_source'
            ?`${acceptance.actor.role==='delegated'?'A delegated answer':'Operator'} accepted the source head ${pr.head} as is without current-head review evidence; entering ordinary verification`
            :`${acceptance.actor.role==='delegated'?'A delegated answer':'Owner'} accepted the reviewed head ${pr.head} with disclosed qualification; entering ordinary verification`)
          :`Owner moved the task to merge at the accepted reviewed head ${pr.head}`).slice(0,2000),
        resolution:{...settledTask.resolution,
          ownerAcceptances:acceptance?[...(settledTask.resolution.ownerAcceptances??[]),acceptance]:settledTask.resolution.ownerAcceptances,
          currentRunId:null,mechanicalVerification:null,
          attention:false,recoveryActive:false,recoveryAttempts:0,
          integrationTurn:settledTask.resolution.integrationTurn??{sequence,acceptedAt:now()}},
      },input.caller?'move_merge_requested':'owner_control',JSON.stringify({verb:'move',to:'merge',head:pr.head,
        ...(acceptance?{qualifiedAcceptance:true,actor:acceptance.actor,authority:acceptance.authority}:{}),
        phaseBefore:settledTask.phase,reason:input.reason}));
      if(settlesProofHold)this.store.event(task.id,'merge_release',`Proof hold released by accepted move to merge at exact head ${pr.head}; ${input.reason}`.slice(0,4000));
      return this.store.task(task.id);
      });
    },`task:${task.id}`);
  }

  /**
   * Papercut c7643943: one durable owner decision to lose the unproven contents
   * of exactly one workspace, bound to its task, workspace and directory and
   * written before any archive effect. A replay or lost reply keeps the first
   * record, and a record naming another directory is a contradiction rather
   * than something to overwrite or to archive through.
   */
  recordWorkspaceDiscard(task:Task,workspaceId:string,directory:string,input:TaskControlInput,
    authority:{kind:'operator'|'relayed_note';note:string|null}):WorkspaceDiscard{
    const key=workspaceDiscardKey(task.id,workspaceId);
    const prior=this.store.getMeta<WorkspaceDiscard>(key);
    if(prior){
      if(prior.workspaceId!==workspaceId||prior.directory!==directory)
        throw Error('A recorded content discard names another directory for this workspace; nothing was written or archived');
      return prior;
    }
    const record:WorkspaceDiscard={workspaceId,directory,caller:input.caller!,authority:authority.kind,note:authority.note,
      reason:(input.reason??'').trim().slice(0,4000),at:now()};
    this.store.transaction(()=>{
      this.store.setMeta(key,record);
      this.store.event(task.id,'workspace_discard_authorized',JSON.stringify(record));
    });
    return record;
  }

  /**
   * Spec 050 `move to=closeout`: record the observed external merge and enter
   * ordinary closeout. It never mints a review: the merge is observed at the
   * forge, the runs settle, and the normal external-merge closeout follows.
   *
   * Task 408: a queued review-entry task that never dispatched is the one shape
   * whose own PR can merge before any reviewer existed. It has no runs to settle
   * and no review evidence at the merged head, so the same verb reconciles it
   * only with an explicit exact-final-head owner source acceptance: the merge is
   * an observed fact, never acceptance, review, proof or author credit, and
   * without that acceptance the task stays held exactly as it is.
   */
  async moveToCloseout(input:{taskId:string;version:number;reason:string;caller?:string;qualification?:string;head?:string;
    relayed?:boolean;relayNote?:string;enclosing?:()=>VerifiedEnclosingOperation|undefined}):Promise<Task>{
    const task=this.store.task(input.taskId);
    if(task.removedAt)throw Error(REMOVED_TASK_REFUSAL);
    this.engine.requireOwnerControlCurrent(task,input.version,'Task changed; refresh before retrying');
    const stateRefusal = moveStateRefusal(task, "closeout");
    if(stateRefusal)throw Error(stateRefusal);
    // Task 408: the never-dispatched review-entry boundary. It is read fresh
    // from the same store fact the dependency correction uses, and only through
    // the authenticated durable invocation executing this
    // move: a direct engine call carries no verified invocation identity and
    // keeps the parent refusal without allowing a forged exemption (task 404).
    const enclosing=input.enclosing?.();
    const boundary=enclosing?this.store.reviewEntryUnrunBeforeFirstRun(task,enclosing):false;
    if(boundary)return this.engine.reconcileReviewEntryExternalMerge({task,reason:input.reason,caller:input.caller,qualification:input.qualification,
      head:input.head,relayed:input.relayed,relayNote:input.relayNote,enclosing:input.enclosing??(()=>undefined)});
    if(input.qualification)return this.engine.reconcileRetainedExternalMerge({task,reason:input.reason,caller:input.caller,qualification:input.qualification,
      head:input.head,relayed:input.relayed,relayNote:input.relayNote,enclosing:input.enclosing??(()=>undefined)});
    if(input.head)throw Error('A head is only named by a move to merge with an owner acceptance; closeout proves the PR merged at the forge');
    // Round 4: a move applies while paused; only dispatch waits for unpause.
    // Spec 050 atomic verbs: nothing settles before the merge is proven —
    // acceptExternalMerge refuses an unmerged PR or an active thread before it
    // writes anything, and the fence settlement rides the accepted merge inside
    // its transaction.
    await this.resolution.acceptExternalMerge(this.store.task(task.id),input.reason,`move closeout: ${input.reason}`,this.engine.coordinatorActionRunId.getStore(),undefined,undefined,input.enclosing);
    return this.store.task(task.id);
  }

  async reconcileRetainedExternalMerge(input:{task:Task;reason:string;caller?:string;qualification:string;head?:string;
    relayed?:boolean;relayNote?:string;enclosing:()=>VerifiedEnclosingOperation|undefined}):Promise<Task>{
    const {task}=input, qualification=input.qualification.trim();
    if(['queued','dispatching'].includes(task.phase) || !task.agentId || !task.runId || !task.workspaceId || !task.directory || !task.prHead || !task.prUrl)
      throw new ExternalMergeRefusal('An operator source acceptance in a closeout applies only to a never-dispatched review-entry task at its boundary or a dispatched task with a retained worker, workspace and recorded PR source; this task is outside that boundary');
    if(!qualification || !input.head || !/^[a-f0-9]{40}$/.test(input.head))
      throw new ExternalMergeRefusal('Accepting a descendant external merge requires qualification and the exact final head');
    const authority=this.engine.assertOwnerAuthority(input.caller,input.relayed,input.relayNote,'External-merge source acceptance');
    const project=this.store.projectFor(task.repoPath,normalizeRepositoryOrigin(task.repository??''));
    if(!project || project.visibility!=='active')throw new ExternalMergeRefusal('The task project is not active');
    const runs=this.store.runs(task.id), projectIdentity=JSON.stringify(project), taskIdentity=JSON.stringify(task), runsIdentity=JSON.stringify(runs);
    const invocation=input.enclosing();
    if(!invocation)throw new ExternalMergeRefusal('An authenticated durable move operation is required');
    const assertState=()=>{
      const current=this.store.task(task.id), enclosing=input.enclosing();
      if(!enclosing || enclosing.operationId!==invocation.operationId || JSON.stringify(current)!==taskIdentity || JSON.stringify(this.store.runs(task.id))!==runsIdentity
        || JSON.stringify(this.store.projectFor(task.repoPath,normalizeRepositoryOrigin(task.repository??'')))!==projectIdentity)
        throw Error('Task, runs, project or move operation changed during external merge proof');
      const refusal=blockingRecoveryEffectsRefusal(this.store,current,{enclosing});
      if(refusal)throw Error(refusal);
      for(const run of this.store.runs(task.id).filter(item=>!item.released)){
        const fence=runSettlementFence({store:this.store,task:current},run);
        if(fence)throw Error(runFenceRefusal(run,fence));
      }
    };
    const acceptanceFor=(head:string):OwnerAcceptanceRecord=>{
      if(head!==input.head)throw Error(`The observed merged head ${head} differs from the exact head accepted`);
      const eligible=qualifiedAcceptanceEligibility({...this.store.task(task.id),prHead:head},this.store.runs(task.id));
      if(!eligible.available)throw Error(eligible.refusal);
      if(eligible.acceptance!=='operator_source')throw Error('Current-head review evidence cannot be replaced by source acceptance');
      return {at:now(),kind:'operator_source',head,prNumber:taskPrNumber(task),review:null,
        actor:{agentId:input.caller!,role:authority.role},authority:{kind:authority.kind,note:authority.note},
        reason:input.reason.trim().slice(0,4000),qualification:qualification.slice(0,4000),missingEvidence:eligible.missingEvidence.slice(0,4000)};
    };
    const participants=executionParticipants(task,runs);
    const assertQuiet=async()=>{
      const workspaces=await this.adapter.findWorkspaces(task);
      if(workspaces.length!==1 || workspaces[0]!.id!==task.workspaceId || workspaces[0]!.directory!==task.directory)
        throw Error('Retained workspace registration is missing, aliased or changed');
      for(const [id,workspaceId] of participants){
        if(this.store.unreleasedRunsForAgent(id,task.hostId).some(run=>run.taskId!==task.id))throw Error(`Participant ${id} owns another unreleased run`);
        this.engine.admission?.invalidate(id);
        let observed:AgentObservation;
        try{observed=await this.engine.host.observe(id);}
        catch(error){throw Error(`Participant ${id} could not be observed (${hostFailureRefusalDetail(error)})`);}
        if(!observed.workspaceId || (workspaceId && observed.workspaceId!==workspaceId) || observed.id!==id || observed.active!==false
          || observed.permissions!==false || observed.activeTurnId || !['idle','error','closed'].includes(observed.status))
          throw Error(`Participant ${id} is active, permission-holding or unobservable`);
        // The shared owned-tool proof reads the timeline, then freshly observes
        // the participant and applies the provider-tree or no-process proof.
        const issue=await this.resolution.participantToolIssue(task.id,id,workspaceId);
        if(issue)throw Error(`Participant ${id} has live or unknown tool effects: ${issue}`);
      }
      assertState();
    };
    try{
      assertState();
      const settleOperation=(settled:Task)=>{
        const enclosing=input.enclosing(), operation=this.store.operation(invocation.operationId);
        if(!enclosing || enclosing.operationId!==invocation.operationId || !operation || operation.state!=='running')
          throw Error('Move operation changed before atomic settlement');
        // The shared owner move releases its own stop hold. Settle it here so
        // an interrupted response cannot strand a hold after a successful move.
        this.engine.releaseOwnerStopHold(settled.id);
        settled=this.store.task(settled.id);
        const at=now();
        this.store.putOperation({...operation,diagnostic:'',
          result:{taskId:settled.id,taskVersion:settled.version,phase:settled.phase,number:settled.number,reference:settled.reference},
          effect:operation.effect?{...operation.effect,status:'reconciled',result:settled.id,resultAt:at}:null});
      };
      return await this.resolution.acceptExternalMerge(task,input.reason,`move closeout: ${input.reason}`,this.engine.coordinatorActionRunId.getStore(),undefined,{acceptanceFor,assertQuiet,assertState,settleOperation});
    }catch(error){throw error instanceof ExternalMergeRefusal?error:new ExternalMergeRefusal(error instanceof Error?error.message:String(error));}
  }

  /**
   * Task 408: the owner closeout reconciliation of a never-dispatched review-
   * entry task whose PR merged outside Queue. It proves the accepting authority,
   * the exact-final-head source acceptance, and fresh inactive ownership; the
   * merge identity, descendant heads and workspace proofs stay in the existing
   * external-merge route. Nothing is dispatched and no review, proof or credit
   * is minted.
   */
  async reconcileReviewEntryExternalMerge(input:{task:Task;reason:string;caller?:string;qualification?:string;head?:string;
    relayed?:boolean;relayNote?:string;enclosing:()=>VerifiedEnclosingOperation|undefined}):Promise<Task>{
    const task=input.task,qualification=input.qualification?.trim();
    if(!qualification)throw Error('This never-dispatched review-entry task has no reviewer, review, verification or proof at the head its PR merged at, so the merge alone is an observed fact, never acceptance. Pass an explicit operator source acceptance — the same `qualification` a move to merge records — to accept that exact merged head, or leave the task held; no approval is invented for it');
    // The merged head is observed, never supplied: a caller cannot name a head
    // as fact at the forge.
    if(input.head)throw Error('The merged head is observed at the forge, never supplied by the caller; omit head and pass only the acceptance');
    const authority=this.engine.assertOwnerAuthority(input.caller,input.relayed,input.relayNote,'External-merge source acceptance');
    const ownerIdentity=JSON.stringify(this.store.projectFor(task.repoPath,normalizeRepositoryOrigin(task.repository??'')));
    // The shared acceptance rule is derived at whatever head the forge reports,
    // so an older head's ruling or the merged status itself never becomes
    // acceptance of the final head.
    const acceptanceFor=(head:string)=>{
      const eligible=qualifiedAcceptanceEligibility({...task,prHead:head},this.store.runs(task.id));
      if(!eligible.available)throw Error(eligible.refusal);
      if(eligible.acceptance!=='operator_source')throw Error('Review evidence already binds the merged head; no external-merge source acceptance applies to it');
      return {
        at:now(),kind:'operator_source' as const,head,prNumber:taskPrNumber(task),review:null,
        actor:{agentId:input.caller!,role:authority.role},
        authority:{kind:authority.kind,note:authority.note},
        reason:input.reason.trim().slice(0,4000),qualification:qualification.slice(0,4000),
        missingEvidence:`The same PR merged outside Nucleus at ${head} before any reviewer, review, verification or proof existed at that head: this task never dispatched, so no review evidence binds it. ${eligible.missingEvidence}`.slice(0,4000),
      } as OwnerAcceptanceRecord;
    };
    // Fresh inactive project state before the forge read and again before the
    // commit: an unknown, active or permission-holding writer is never read as
    // absent.
    const assertQuiet=async()=>{
      const project=this.store.projectFor(task.repoPath,normalizeRepositoryOrigin(task.repository??''));
      if(!project||project.visibility!=='active')
        throw Error('The task project is not active; the external-merge source acceptance is refused');
      if(JSON.stringify(project)!==ownerIdentity)throw Error('Project changed during external merge proof');
      for(const [id,workspaceId] of executionParticipants(task,this.store.runs(task.id))){
        this.engine.admission?.invalidate(id);
        let observed:AgentObservation;
        try{observed=await this.engine.host.observe(id);}
        catch(error){throw Error(`Participant ${id} could not be observed (${hostFailureRefusalDetail(error)})`);}
        if(observed.id!==id||observed.workspaceId!==workspaceId||observed.status!=='idle'||observed.active!==false||observed.activeTurnId||observed.permissions!==false||this.store.unreleasedRunsForAgent(id,task.hostId).some(run=>run.taskId!==task.id))
          throw Error(`Participant ${id} has observed activity, a permission or unknown identity`);
        const issue=await this.resolution.participantToolIssue(task.id,id,workspaceId);
        if(issue)throw Error(`Participant ${id} has running or unknown tool effects (${issue})`);
      }
    };
    try {
      return await this.resolution.acceptExternalMerge(this.store.task(task.id),input.reason,`move closeout: ${input.reason}`,
        this.engine.coordinatorActionRunId.getStore(),{enclosing:input.enclosing,acceptanceFor,assertQuiet});
    } catch (error) {
      // Every refusal on this path happens before its one transaction, so it is
      // definite: nothing was merged, accepted or dispatched.
      throw error instanceof ExternalMergeRefusal ? error : new ExternalMergeRefusal(error instanceof Error ? error.message : String(error));
    }
  }
}
