import { REMOVED_TASK_REFUSAL } from './control-refusals';
import { readyReviewAtHead } from '../recovery/task-reasons';
import type { Task, TaskControlInput } from "../../shared/contracts";
import { TASK_OWNER_HOLD } from "../../shared/contracts";
import { briefDigest, currentBrief, isBriefMode } from "../planning/brief";
import { Decisions } from "../planning/decisions";
import type { Engine } from "../engine";
import { git } from "../git/index";
import { parseNorthstarDocument, submissionQueueFields } from "../planning/handoff";
import { instructionForCommit } from "../hooks/hooks";
import { holdPatch, releasePatch, HOLD_REASON_NOT_RECORDED } from "../merge/merge-hold";
import { proofDeclarationSummary, proofInputRedeclarationAllowed, proofReservation, sameProofDeclaration, spentProofExecution } from "../qa/proof-execution";
import { STEPS_RETIRED_REASON } from "../recovery/retired-steps";
import { stageDeclarationFromBrief } from "../stages";

/**
 * Changing what a task was told to do after submission: re-pinning a committed
 * handoff, amending a Nucleus-held brief, and the stage-plan refusal admission
 * shares. Same-name `Engine` methods delegate here.
 */
export class BriefControls {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  /**
   * Re-pin a task's instruction artifact to the bytes committed at its integration base.
   *
   * The instruction pin exists so a dispatched worker's instruction cannot drift, and it is
   * right that the pre-merge gate refuses when the committed artifact changes. It also means
   * a legitimate owner recut of a handoff after task creation holds every gate forever: the
   * recorded occurrence pins bytes that are no longer at the base, and the worker cannot
   * restore them without undoing the recut.
   *
   * This is an operator action with no guessing in it. It reads the artifact committed at the
   * task's own integration base and refuses anything but that - so it can only pin bytes the
   * repository actually carries - leaves task, worker, branch, PR and head identity alone,
   * and returns the task to the verification phase so the pre-merge gate runs fresh against
   * the new pin rather than replaying the occurrence that pinned the old bytes.
   */
  async repinInstruction(input:{taskId:string;version:number}):Promise<Task>{
    if(isBriefMode(this.store.task(input.taskId)))throw Error('Instruction re-pin does not apply to a Nucleus-held brief; use amend_brief with the new text and a reason');
    return this.engine.control(async()=>{
      const task=this.store.task(input.taskId);
      this.engine.requireOwnerControlCurrent(task,input.version,'Task changed; refresh before retrying');
      this.engine.rejectFenced(task, "instruction re-pin");
      if(isBriefMode(task))throw Error('Instruction re-pin does not apply to a Nucleus-held brief; use amend_brief with the new text and a reason');
      if(this.engine.neverDispatched(task))throw Error('A submitted handoff is immutable before dispatch; resubmit the changed handoff and supersede this task');
      if(!task.instruction)throw Error('Instruction re-pin requires a pinned instruction artifact');
      if(["done","cancelled"].includes(task.phase))throw Error('Instruction re-pin requires a task that has not closed');
      if(task.resolution.mergedCommit)throw Error('Instruction re-pin requires an unmerged task');
      // The artifact must be read at the CURRENT integration base, which is what the
      // pre-merge gate compares against. Reading it at the pin's own commit would compare
      // the pin with itself and always match.
      const base=await git(task.repoPath,'rev-parse',`refs/heads/${task.baseBranch}`);
      const atBase=await instructionForCommit(task.repoPath, base, task.instruction.path, task.instruction.mediaType);
      if(atBase.digest===task.instruction.digest)throw Error('The pinned instruction already matches the artifact committed at the integration base');
      const pinned={...task.instruction, commit: base, digest: atBase.digest};
      // Re-running the pre-merge gate is only the right next step for a lane held there:
      // an accepted review at the current head and nothing running. Otherwise the re-pin
      // changes the pin only. Moving a lane whose stopped revision still holds it (g05.180)
      // to verifying erased the state its recovery controls need.
      const acceptedHead=readyReviewAtHead(task);
      const idle=!this.store.runs(task.id).some(run=>!run.released);
      if(!acceptedHead||!idle)
        return this.store.update(task.id,{instruction:pinned},'instruction_repinned',`pin only at ${base.slice(0,12)}; lane state unchanged`);
      return this.store.update(task.id,{
        instruction: pinned,
        resolution:{ ...task.resolution, mechanicalVerification:null, attention:false, integrationTurn:null },
        phase:'verifying',
        reason:`Instruction re-pinned to the artifact committed at ${base.slice(0,12)}; re-running the pre-merge gate`,
      },'instruction_repinned');
    }, `task:${input.taskId}`);
  }
  /**
   * Spec 020 operator amendment of a Queue-held brief. It pins a new version by digest and
   * keeps every earlier version. It changes no run, worker, branch or PR. A live worker or
   * reviewer is told of the amendment as a message queued behind its current step; a
   * superseded nucleus_ask is answered with the new brief. The next run is given the new
   * version. Refused once the task has merged.
   */
  amendBrief(input:{taskId:string;version:number;brief:string;reason:string;overtakes?:string[]}):Task{
    const apply=()=>{
      let task=this.store.task(input.taskId);
      if(task.removedAt)throw Error(REMOVED_TASK_REFUSAL);
      this.engine.requireOwnerControlCurrent(task,input.version,'Task changed; refresh before retrying');
      this.engine.rejectFenced(task, "brief amendment");
      if(!isBriefMode(task))throw Error('Brief amendment requires a Nucleus-held brief; a committed handoff changes through planning, then amend_brief with no text re-pins it');
      if(task.resolution.mergeIntent||task.resolution.mergedCommit||['merging','syncing','closing','done'].includes(task.phase))throw Error('Brief amendment is refused once merging has started or merge intent exists; it is also refused once the task has merged');
      if(task.phase==='cancelled')throw Error('Brief amendment requires a live task');
      const reason=input.reason.trim();
      const overtakes=[...new Set(input.overtakes??[])];
      if(overtakes.length>100)throw Error('A brief amendment can overtake at most 100 decisions');
      if(!reason)throw Error('A brief amendment requires its reason');
      // Parse under the schema the task was created with: lead-promoted briefs carry approval in
      // provenance, not queue_approval; a directly submitted brief still requires it.
      const amendSchema=task.leadProvenance?'draft':'brief';
      const document=input.brief.startsWith('---')?parseNorthstarDocument(input.brief,amendSchema):null;
      const queue=document?.queue??null;
      if (queue?.responsible === false) throw Error('queue.responsible: false is no longer supported; every task runs the responsible lifecycle');
      if (queue?.manualVerification === true) throw Error('queue.manualVerification is no longer available; every task runs the responsible lifecycle');
      if(queue?.stages)throw Error(STEPS_RETIRED_REASON);
      const current=currentBrief(task)!;
      // The previous text is read to diff its routing and hold fields, so it is parsed
      // with the lenient draft schema: a brief pinned before today's frontmatter
      // rules (no queue_approval) must still amend. Unparsable old text falls
      // back to the task's hold.
      let previousQueue:Record<string,unknown>|null=null;
      if(current.text.startsWith('---')){
        try{previousQueue=parseNorthstarDocument(current.text,'draft').queue??null;}
        catch{previousQueue={mergeHold:task.mergeHold};}
      }
      const next={version:current.version+1,digest:briefDigest(input.brief),mediaType:current.mediaType,text:input.brief,reason,pinnedAt:new Date().toISOString()};
      if(next.digest===current.digest)throw Error('The amended brief is identical to the pinned version');
      task=this.applyQueuedRouting(task,queue,previousQueue??{},reason);
      const changes:Partial<Task>={
        ...(document?{title:document.title}:{}),
        brief:{text:next.text,mediaType:next.mediaType,digest:next.digest},handoffText:next.text,briefVersions:[...task.briefVersions,next],
      };
      const gateEvents:{kind:string;detail:string}[]=[];
      if(queue){
        const mergeHold=queue.mergeHold===true;
        const previousMergeHold=previousQueue?.mergeHold===true;
        if(mergeHold!==previousMergeHold||(mergeHold&&queue.mergeHoldReason!==previousQueue?.mergeHoldReason)){
          Object.assign(changes,mergeHold?holdPatch(task,"merge",TASK_OWNER_HOLD,queue.mergeHoldReason??HOLD_REASON_NOT_RECORDED):releasePatch(task,"merge"));
          gateEvents.push({kind:'brief_merge_hold_changed',detail:`${previousMergeHold} → ${mergeHold}; ${reason}`});
        }
        // Spec 051: only an explicit queue.interactive changes the mode (it may also come
        // from queue.submit), and the worker prompt carries it, so only before dispatch.
        const interactive=queue.interactive;
        const previousInteractive=task.interactive===true;
        if(interactive!==undefined&&interactive!==previousInteractive){
          if(task.phase!=='queued'||task.agentId||task.agentIntent)throw Error('queue.interactive changes only before dispatch; the running worker already has its instructions');
          changes.interactive=interactive;
          gateEvents.push({kind:'brief_interactive_changed',detail:`${previousInteractive} → ${interactive}; ${reason}`});
        }
      }
      // Task 407/549: the accepted brief is the operative proof declaration. Its
      // selector stays immutable after reservation; input hashes may follow a
      // corrected source only after an authenticated revision and source approval.
      const declaredProof=document?(queue?.proofExecution??null):undefined;
      if(declaredProof!==undefined){
        const proofRuns=this.store.runs(task.id);
        const reservation=proofReservation(task,proofRuns);
        if(task.proofExecutionRetired&&declaredProof)
          throw Error('This task retired its author-side proof declaration; a later amendment cannot name a selector again and nothing was written');
        if(task.proofExecutionRetired){
          // The declaration stays retired through body-only/frontmatter amendments.
        }else if(declaredProof===null&&task.proofExecution){
          const spent=spentProofExecution(task,proofRuns);
          if(spent&&spent.selector===task.proofExecution.selector&&spent.settledAt&&spent.status!=='running'&&spent.status!=='unknown'){
            const uncertain=proofRuns.some(run=>{
              if(run.role!=='executor')return false;
              const receipt=task.proofExecutions.find(item=>item.runId===run.id);
              return !run.released||!receipt||receipt.status==='running'||receipt.status==='unknown'||!receipt.settledAt;
            });
            if(uncertain)
              throw Error('This task cannot retire its author-side proof declaration while an executor run is live or uncertain; nothing was written');
            changes.proofExecution=undefined;
            changes.proofExecutionRetired=true;
            gateEvents.push({kind:'brief_proof_execution_retired',detail:`${proofDeclarationSummary({selector:task.proofExecution.selector,inputs:task.proofExecution.inputs})}; ${reason}`});
          }
        }
        // Compare with the operative declaration first. A prior #549 amendment
        // may have re-declared inputs for a qualified new head, while the
        // append-only reservation still correctly records the original inputs.
        // Keeping the current declaration is a body-only amendment and needs no
        // second re-declaration check.
        if(!task.proofExecutionRetired&&!changes.proofExecutionRetired&&!sameProofDeclaration(declaredProof,task.proofExecution??null)&&reservation){
          if(!reservation.declaration || declaredProof?.selector!==reservation.declaration.selector)
            throw Error(`This task already reserved an author-side proof execution (${reservation.runId}, ${reservation.status}) for ${proofDeclarationSummary(reservation.declaration)}; the selector is immutable, so an amendment that changes or removes it is refused and nothing was written`);
          if(!sameProofDeclaration(declaredProof,reservation.declaration)){
            const runs=this.store.runs(task.id);
            if(!task.prHead||!proofInputRedeclarationAllowed(task,runs,task.prHead))
              throw Error(`This task already reserved an author-side proof execution (${reservation.runId}, ${reservation.status}); input hashes may be re-declared only for a new head with an authenticated author revision and retained reviewer source approval, and nothing was written`);
            changes.proofExecution=declaredProof!;
            gateEvents.push({kind:'brief_proof_execution_changed',detail:`${proofDeclarationSummary(reservation.declaration)} → ${proofDeclarationSummary(declaredProof)} at ${task.prHead}; ${reason}`});
          }
        }else if(!task.proofExecutionRetired&&!changes.proofExecutionRetired&&!reservation&&!sameProofDeclaration(declaredProof,task.proofExecution??null)){
          // Absent in the accepted brief clears an unspent declaration; a different one
          // replaces it. No execution exists either way, so no credit is minted or moved.
          changes.proofExecution=declaredProof??undefined;
          gateEvents.push({kind:'brief_proof_execution_changed',detail:`${proofDeclarationSummary(task.proofExecution??null)} → ${proofDeclarationSummary(declaredProof)}; ${reason}`});
        }
      }
      const amended=this.store.update(task.id,changes,'brief_amended',`version ${next.version} ${next.digest}: ${reason}${overtakes.length?`; overtakes ${overtakes.join(', ')}`:''}`);
      const decisions=new Decisions(this.store);
      for(const id of overtakes)decisions.markOvertaken(id,{kind:'brief_amendment',id:task.id,sourceId:`brief-v${next.version}`,label:`Brief amendment for task ${task.id}: ${reason}`,at:next.pinnedAt});
      for(const event of gateEvents)this.store.event(task.id,event.kind,event.detail);
      const answered=this.answerOpenAsksWithAmendment(amended, next, reason);
      this.recordAmendmentDeliveries(amended, next);
      return {amended, answered};
    };
    const pinned=this.store.db.isTransaction?apply():this.store.transaction(apply);
    for(const item of pinned.answered)this.engine.resolution.notifyAskAnswered(pinned.amended.id,item.askId,item.answer,'brief amendment');
    this.sendRecordedAmendmentDeliveries(pinned.amended);
    return pinned.amended;
  }
  /** Routing and brief writes share the amendment transaction, including every refusal. */
  private applyQueuedRouting(task:Task,queue:Record<string,unknown>|null,previous:Record<string,unknown>,reason:string):Task{
    // Body-only edits keep stored routing, but delivery mode follows the brief's bytes.
    // Submission conversion omits these delivery fields; amendment comparison must retain them.
    const next:Record<string,unknown>={completionNotificationAgentIds:[],...submissionQueueFields(queue??previous),reportOnly:queue?.reportOnly,reportLane:queue?.reportLane};
    const prior:Record<string,unknown>={completionNotificationAgentIds:[],...submissionQueueFields(previous),reportOnly:previous.reportOnly,reportLane:previous.reportLane};
    const defaults:Record<string,unknown>={dependsOn:[],lanes:[],scope:'general',complexity:null,
      preferredProfileId:'',requirePreferred:false,thinkingOptionId:'',profileRequests:{},
      siblings:true,interactive:false,
      critical:false,laneDocuments:undefined};
    const managed=new Set(['mergeHold','mergeHoldReason','proofExecution','responsible','manualVerification','reviewContinuationIds']);
    const fields=[...new Set([...Object.keys(next),...Object.keys(prior)])].filter(key=>
      !managed.has(key)&&!(key==='interactive'&&queue?.interactive===undefined)
      &&JSON.stringify(next[key])!==JSON.stringify(prior[key]));
    if(!fields.length)return task;
    const beforeDispatch=task.phase==='queued'&&this.engine.neverDispatched(task)
      &&!task.workspaceIntent&&!task.workspaceId&&!task.agentIntent&&!task.agentId;
    const refused=fields.filter(key=>!(key in defaults)||!beforeDispatch);
    if(refused.length)throw Error(`Brief routing changes refused: ${refused.map(key=>`queue.${key}`).join(', ')}; ${beforeDispatch?'these fields cannot change through amend_brief':'routing changes only before dispatch'}; nothing was written`);
    const values=Object.fromEntries(fields.map(key=>[key,next[key]??defaults[key]]));
    if(fields.includes('dependsOn'))task=this.store.updateDependencies(task,(values.dependsOn as string[]).map(id=>this.store.resolveTaskId(id)),'brief amendment');
    if(fields.includes('lanes'))task=this.store.setTaskLanes(task,values.lanes as string[],task.repository);
    const routingKeys=['scope','complexity','preferredProfileId','requirePreferred','thinkingOptionId','profileRequests','critical'];
    if(fields.some(key=>routingKeys.includes(key))){
      // Use the ordinary profile validation and sign-off path. A document supplies no board authority.
      const routing=Object.fromEntries(routingKeys.filter(key=>key in values).map(key=>[key,values[key]]));
      if(fields.includes('profileRequests')){
        const requests={...(values.profileRequests as NonNullable<Task['profileRequests']>)};
        for(const role of ['worker','reviewer','coordinator'] as const)
          if(task.profileRequests?.[role]&&!requests[role])Object.assign(requests,{[role]:null});
        routing.profileRequests=requests;
      }
      // Critical is a routing field here, before dispatch only; it grants no force or operator authority.
      const {critical,...ordinary}=routing;
      if(Object.keys(ordinary).length)task=this.engine.applyTaskControlSetRouting({taskId:task.id,version:task.version,
        action:'set_routing',reason,...ordinary} as TaskControlInput,result=>result);
      if(critical!==undefined)task=this.store.update(task.id,{critical:critical as boolean},'brief_critical_changed',reason);
    }
    const direct=Object.fromEntries(fields.filter(key=>!['dependsOn','lanes','interactive',...routingKeys].includes(key)).map(key=>[key,values[key]]));
    if(Object.keys(direct).length)task=this.store.update(task.id,direct,'brief_routing_changed',JSON.stringify({fields:Object.keys(direct),reason}));
    return task;
  }
  /** An open nucleus_ask about the previous brief is answered with the amendment. The linked board decision is withdrawn here because the later supersede sweep skips an already-answered ask. */
  private answerOpenAsksWithAmendment(task:Task, next:{version:number;digest:string}, reason:string):Array<{askId:string;answer:string}>{
    const events=this.store.eventsAll(task.id);
    const settled=(kind:string,id:string)=>events.some(event=>event.kind===kind&&event.detail.startsWith(`${id}:`));
    const answer=`The operator amended the brief to version ${next.version} (${next.digest}). Reason: ${reason}. Continue from the new brief.`;
    const answered:Array<{askId:string;answer:string}>=[];
    const decisions=new Decisions(this.store);
    const withdrawReason=`brief amendment to version ${next.version}: ${reason}`;
    for(const event of events.filter(item=>item.kind==='agent_ask')){
      const id=event.detail.split(':',1)[0]!;
      if(!id||settled('agent_ask_answered',id)||settled('agent_ask_superseded',id))continue;
      this.store.event(task.id,'agent_ask_answered',`${id}: answered by brief amendment: ${answer}`);
      const link=events.find(item=>item.kind==='agent_ask_decision'&&item.detail.startsWith(`${id}: decision `));
      const decisionId=link?.detail.match(/decision ([^;\s]+)/)?.[1];
      if(decisionId){
        const decision=this.store.decision(decisionId);
        if(decision.status==='open')decisions.withdrawInTransaction({id:decisionId,version:decision.version,
          reason:withdrawReason,withdrawnBy:'nucleus'});
      }
      answered.push({askId:id,answer});
    }
    return answered;
  }
  private amendmentMessage(next:{version:number;digest:string;text:string;reason:string}):string{
    return `The operator amended this task's Nucleus-held brief to version ${next.version} (${next.digest}). Reason: ${next.reason}. This message is queued behind your current step; continue from the new brief. Earlier instructions that conflict with it no longer apply.\n\n${next.text}`;
  }
  /** Durable send intent for each live worker and reviewer thread; unknown delivery is never resent. */
  private recordAmendmentDeliveries(task:Task, next:{version:number}):void{
    const events=this.store.eventsAll(task.id);
    for(const role of ['worker','reviewer'] as const){
      const identity=this.engine.resolution.agentMessages.messageRecipientIdentity(task,role);
      if(!identity.live||!identity.agentId)continue;
      const messageId=`ns-brief-amendment-${task.id}-v${next.version}-${role}`;
      if(events.some(event=>event.kind==='brief_amendment_delivery_intent'&&event.detail.startsWith(`${messageId}:`)))continue;
      this.store.event(task.id,'brief_amendment_delivery_intent',`${messageId}: host ${task.hostId??'none'}; agent ${identity.agentId}; role ${role}; version ${next.version}`);
    }
  }
  private sendRecordedAmendmentDeliveries(task:Task):void{
    const current=this.store.task(task.id);
    const next=current.briefVersions.at(-1);
    if(!next)return;
    const text=this.amendmentMessage(next);
    const events=this.store.eventsAll(current.id);
    for(const event of events.filter(item=>item.kind==='brief_amendment_delivery_intent')){
      const messageId=event.detail.split(':',1)[0]!;
      if(!messageId)continue;
      if(events.some(item=>item.kind==='brief_amendment_delivered'&&item.detail.startsWith(`${messageId}:`)))continue;
      const match=event.detail.match(/agent (\S+); role (\S+);/);
      const agentId=match?.[1];
      if(!agentId||!current.hostId)continue;
      if(!this.engine.resolution.withHost(current.hostId,()=>this.engine.resolution.originHostAvailable(current.hostId!)&&Boolean(this.engine.adapter.enqueueMessage)))continue;
      void this.engine.resolution.withHost(current.hostId,()=>this.engine.adapter.enqueueMessage!(agentId,messageId,text))
        .then(()=>{
          if(!this.store.eventsAll(current.id).some(item=>item.kind==='brief_amendment_delivered'&&item.detail.startsWith(`${messageId}:`)))
            this.store.event(current.id,'brief_amendment_delivered',`${messageId}: queued for ${agentId}`);
        })
        .catch(()=>{ /* delivery is unknown; the intent prevents a resend */ });
    }
  }
  /** Spec 043: refusal for any brief text that still declares a stage plan. */
  briefStageProfileRefusal(text:string,_scope:Task["scope"]):string|null{
    return stageDeclarationFromBrief(text) ? STEPS_RETIRED_REASON : null;
  }
}
