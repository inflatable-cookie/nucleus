import { REMOVED_TASK_REFUSAL } from './control-refusals';
import { readyReviewAtHead } from '../recovery/task-reasons';
import { retiredSubmissionRefusals, type Task } from "../../shared/contracts";
import { briefDigest, currentBrief, isBriefMode } from "../planning/brief";
import { Decisions } from "../planning/decisions";
import type { Engine } from "../engine";
import { git } from "../git/index";
import { parseNorthstarDocument } from "../planning/handoff";
import { instructionForCommit } from "../hooks/hooks";
import { STEPS_RETIRED_REASON } from "../recovery/retired-steps";
import { stageDeclarationFromBrief } from "../stages";
import { BriefAmendmentDelivery } from "./brief-amendment";
import { reconcileBriefProofDeclaration } from "./brief-proof";
import { applyBriefRouting } from "./brief-routing";

/**
 * Changing what a task was told to do after submission: re-pinning a committed
 * handoff, amending a Nucleus-held brief, and the stage-plan refusal admission
 * shares. Same-name `Engine` methods delegate here.
 */
export class BriefControls {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  private readonly amendmentDelivery = new BriefAmendmentDelivery(this.engine);
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
      // The retired-flag rule and its frontmatter wording are the schema owner's.
      const retired = retiredSubmissionRefusals({ responsible: queue?.responsible, manualVerification: queue?.manualVerification }, 'frontmatter')[0];
      if (retired) throw Error(retired.message);
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
      const changes:Partial<Task>={
        ...(document?{title:document.title}:{}),
        brief:{text:next.text,mediaType:next.mediaType,digest:next.digest},handoffText:next.text,briefVersions:[...task.briefVersions,next],
      };
      const gateEvents:{kind:string;detail:string}[]=[];
      task=applyBriefRouting(this.engine,{task,queue,previous:previousQueue??{},reason,gateEvents,changes});
      const declaredProof=document?(queue?.proofExecution??null):undefined;
      const proof=reconcileBriefProofDeclaration({store:this.store,task,declaredProof,reason});
      Object.assign(changes,proof.changes);
      gateEvents.push(...proof.gateEvents);
      const amended=this.store.update(task.id,changes,'brief_amended',`version ${next.version} ${next.digest}: ${reason}${overtakes.length?`; overtakes ${overtakes.join(', ')}`:''}`);
      const decisions=new Decisions(this.store);
      for(const id of overtakes)decisions.markOvertaken(id,{kind:'brief_amendment',id:task.id,sourceId:`brief-v${next.version}`,label:`Brief amendment for task ${task.id}: ${reason}`,at:next.pinnedAt});
      for(const event of gateEvents)this.store.event(task.id,event.kind,event.detail);
      const answer=`The operator amended the brief to version ${next.version} (${next.digest}). Reason: ${reason}. Continue from the new brief.`;
      const answered=this.engine.resolution.answerOpenAgentAsks(amended.id, answer, `brief amendment to version ${next.version}: ${reason}`)
        .map(askId=>({askId,answer}));
      this.amendmentDelivery.recordIntents(amended, next.version);
      return {amended, answered};
    };
    const pinned=this.store.db.isTransaction?apply():this.store.transaction(apply);
    for(const item of pinned.answered)this.engine.resolution.notifyAskAnswered(pinned.amended.id,item.askId,item.answer,'brief amendment');
    void this.amendmentDelivery.deliverPending(pinned.amended.id).catch(() => { /* the recorded intent is delivered by the next pass */ });
    return pinned.amended;
  }
  /** Spec 043: refusal for any brief text that still declares a stage plan. */
  briefStageProfileRefusal(text:string,_scope:Task["scope"]):string|null{
    return stageDeclarationFromBrief(text) ? STEPS_RETIRED_REASON : null;
  }
}
