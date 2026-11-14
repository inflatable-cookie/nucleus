import type { z } from "zod";
import { digest as storeDigest, operationInputHash } from "../store/store";
import { git } from "../git/index";
import type { Lead } from "../../shared/contracts";
import { OPERATION_COMPATIBILITY_WAIT_MS, type OperationResult } from "../../shared/operations";
import { COMPLEXITY_REQUIRED } from "../../shared/demand";
import { MAX_TITLE_LENGTH, parseHoldUntil, sourcePromotionInputSchema, sourcePromotionOperationPayloadSchema, sourcePromotionOutputSchema } from "../../shared/contracts";
import { holdPatch, OPERATOR_HOLD_OWNER } from "../merge/merge-hold";
import { briefDigest, hasBriefFrontmatter } from "../planning/brief";
import { parseNorthstarDocument } from "../planning/handoff";
import { laneListsRepository } from "../../shared/lanes";
import type { Store } from "../store/store";
import type { PlanningContext, RuntimePlanning } from "./planning";

function assertPromotionActor(input: { board: boolean; agent?: string; note: string }): void {
  if (!input.board && (!input.agent?.trim() || !input.note.trim())) throw new Error("Agent promotion requires an agent and operator authorization note");
  if (input.board && input.agent) throw new Error("Board promotion records operator (board), without an agent");
}

/** Acceptance and execution of durable lead and papercut promotions. */
export class PlanningPromotion {
  constructor(private readonly context: PlanningContext, private readonly planning: Pick<RuntimePlanning, "sourceBriefId" | "selectLeadRepository" | "latestLeadAuthor" | "checkLead" | "approveLead" | "checkDraft">) {}
  private papercutPromotionRepository(cut: ReturnType<Store["papercut"]>) {
    const origin=cut.repository.origin;
    const registered=this.context.store.projects().flatMap(project=>project.repositories)
      .find(repository=>repository.origin===origin && repository.path.trim());
    const path=registered?.path || this.context.store.repositoryFor(origin)?.repository.path?.trim() || cut.repository.path;
    return {...cut.repository,path};
  }
  private leadApprovalMatches(lead: Lead, digest: string) {
    const approval=lead.approval, check=lead.check;
    if (!approval || !check?.ok || approval.version!==lead.version || approval.digest!==digest || !check.planningCommit) return false;
    const checkedBaseBranch=check.baseBranch ?? (lead.baseBranch==="main"?"main":null);
    const approvedBaseBranch=approval.baseBranch ?? (lead.baseBranch==="main"?checkedBaseBranch:null);
    const approvedHead=approval.planningCommit ?? (lead.baseBranch==="main"?check.planningCommit:null);
    return checkedBaseBranch===lead.baseBranch && approvedBaseBranch===lead.baseBranch
      && approvedHead===check.planningCommit;
  }
  /**
   * A settled promotion's reply names its task and the host selection that task
   * took, so the caller can see which host it will run on without a second read.
   */
  promotionReply(taskId: string): { taskId: string; hostId?: string; hostSelection?: import('../../shared/host-selection').HostSelection } {
    const task = this.context.store.task(taskId);
    return { taskId: task.id, ...(task.hostSelection ? { hostId: task.hostSelection.hostId, hostSelection: task.hostSelection } : {}) };
  }
  promoteLeadToTask(input:{id:string;repository?:string;baseBranch?:string;agent?:string;note:string;board:boolean;hold?:{reason:string;until?:string};identitySource?:z.infer<typeof sourcePromotionInputSchema>["identitySource"]}) {
    return this.promotePlanningSource("lead",input);
  }
  promotePapercutToTask(input:{id:string;repository?:string;baseBranch?:string;agent?:string;note:string;board:boolean;hold?:{reason:string;until?:string};complexity?:z.infer<typeof sourcePromotionInputSchema>["complexity"];identitySource?:z.infer<typeof sourcePromotionInputSchema>["identitySource"]}) {
    return this.promotePlanningSource("papercut",input);
  }
  private async promotePlanningSource(kind:"lead"|"papercut",input:{id:string;repository?:string;baseBranch?:string;agent?:string;note:string;board:boolean;hold?:{reason:string;until?:string};complexity?:z.infer<typeof sourcePromotionInputSchema>["complexity"];identitySource?:z.infer<typeof sourcePromotionInputSchema>["identitySource"]}):Promise<z.infer<typeof sourcePromotionOutputSchema>> {
    await this.context.started;
    const request=sourcePromotionInputSchema.parse(input);
    assertPromotionActor(request);
    const lead=kind==="lead"?this.context.store.lead(request.id):null;
    const cut=kind==="papercut"?this.context.store.papercut(request.id):null;
    if (lead?.state==="dropped" || cut?.state==="closed") throw new Error("Source is closed");
    if (lead && request.baseBranch && request.baseBranch!==lead.baseBranch) throw new Error("Edit the lead's baseBranch before promotion");
    if (cut && request.baseBranch && request.baseBranch!=="main") throw new Error("Papercut promotion uses main");
    const repository=lead?this.planning.selectLeadRepository(lead,request.repository):this.papercutPromotionRepository(cut!);
    const sourceDigest=lead
      ? storeDigest(JSON.stringify([lead.version,briefDigest(lead.body)]))
      : storeDigest(JSON.stringify(cut));
    const existing=this.context.store.sourcePromotionResult({kind,id:request.id},repository.origin,lead?.version??null,sourceDigest);
    if (existing) return {...this.promotionReply(existing.taskId!),reference:existing.reference!};
    if (lead) {
      if (!hasBriefFrontmatter(lead.body)) throw new Error("Lead has no brief to promote");
      parseNorthstarDocument(lead.body,"draft");
      const digest=briefDigest(lead.body);
      if (request.board && !this.leadApprovalMatches(lead,digest))
        throw new Error("Approve this lead before promotion");
    }
    else if (cut!.title.length > MAX_TITLE_LENGTH) throw new Error("Task title must be 200 characters or fewer");
    if (lead && request.complexity) throw new Error("A lead names its complexity in its brief (queue.complexity); edit the lead instead");
    const source={kind,id:request.id,repository:repository.origin,version:lead?.version??null,digest:sourceDigest,
      ...(lead?{approval:lead.approval}:{})};
    const operationPayload=sourcePromotionOperationPayloadSchema.parse({type:"source_promote",source,request:{...request,repository:repository.origin}});
    // Observe an unfinished delivery before considering a fresh checked approval attempt.
    const unfinished=this.context.store.unfinishedSourcePromotion(source);
    // A papercut's generated brief carries the requested complexity, so it is part of the attempt's identity.
    const revision=lead?JSON.stringify([lead.version,briefDigest(lead.body),lead.baseBranch,lead.approval]):JSON.stringify([sourceDigest,request.complexity]);
    const baseKey=`source-promote:${operationInputHash([kind,request.id,repository.origin,revision])}`;
    let key=unfinished?.key??baseKey;
    if (!unfinished) {
      // A failed attempt whose effect is reconciled is proven not to have
      // inserted anything, so the same lead may be promoted again under a fresh
      // key; an uncertain attempt keeps its key and must be reconciled first.
      for (let retry=1;;retry++) {
        const prior=this.context.store.operationForKey(key);
        if (prior?.state!=='failed' || prior.effect?.status!=='reconciled') break;
        key=`${baseKey}:retry:${retry}`;
      }
    }
    const existingOperation=unfinished??this.context.store.operationForKey(key);
    // Spec 053: a new promotion names its complexity (a papercut in the request,
    // a lead in its brief). It is refused before any operation exists, so a retry
    // that names one is a fresh attempt; an operation already accepted replays.
    if (!existingOperation) {
      const named=lead ? parseNorthstarDocument(lead.body,"draft").queue.complexity : request.complexity;
      if (!named) throw new Error(lead ? `Lead brief: ${COMPLEXITY_REQUIRED}` : COMPLEXITY_REQUIRED);
    }
    const payload=existingOperation?this.context.store.operationPayload(existingOperation.id):operationPayload;
    const acceptance=await this.context.engine.startOperation({key,kind:"source_promote",payload,repoPath:repository.path,hostId:request.hostId});
    if ("backpressured" in acceptance) return acceptance;
    const operation=await this.context.engine.awaitOperation(acceptance.operation.id,OPERATION_COMPATIBILITY_WAIT_MS);
    if (operation.state==="succeeded" && operation.result?.taskId)
      return {...this.promotionReply(operation.result.taskId),reference:operation.result.reference??""};
    if (operation.state==="failed") throw new Error(operation.diagnostic||"Task promotion failed");
    return {accepted:true,operation};
  }
  async executeSourcePromotion(payload:unknown, hostId?: string, selection?: import('../../shared/operations').QueueOperation['hostSelection']):Promise<OperationResult> {
    const parsed=sourcePromotionOperationPayloadSchema.parse(payload);
    const {source,request}=parsed;
    const kind=source.kind,input=request;
    assertPromotionActor(input);
    if (kind==="lead" && input.complexity) throw new Error("A lead names its complexity in its brief (queue.complexity); edit the lead instead");
    const lead=kind==="lead"?this.context.store.lead(input.id):null;
    const cut=kind==="papercut"?this.context.store.papercut(input.id):null;
    const papercutDigest=cut?storeDigest(JSON.stringify(cut)):null;
    if (source.id!==input.id || source.repository!==input.repository)
      throw new Error("Promotion source does not match its request");
    const existing=this.context.store.sourcePromotionResult({kind,id:source.id},source.repository,source.version,source.digest);
    if (existing) return existing;
    if (lead?.state==="dropped" || cut?.state==="closed") throw new Error("Source is closed");
    if (lead && input.baseBranch && input.baseBranch!==lead.baseBranch) throw new Error("Edit the lead's baseBranch before promotion");
    if (cut && input.baseBranch && input.baseBranch!=="main") throw new Error("Papercut promotion uses main");
    const repository=lead?this.planning.selectLeadRepository(lead,input.repository):this.papercutPromotionRepository(cut!);
    const currentDigest=lead
      ? storeDigest(JSON.stringify([lead.version,briefDigest(lead.body)]))
      : storeDigest(JSON.stringify(cut));
    if (source.version!==(lead?.version??null) || currentDigest!==source.digest)
      throw new Error(`${kind==="lead"?"Lead":"Papercut"} changed during promotion; reload`);
    if (lead && source.approval!==undefined && JSON.stringify(source.approval)!==JSON.stringify(lead.approval))
      throw new Error("Lead approval changed while promotion was queued; reload");
    if (lead) {
      if (!hasBriefFrontmatter(lead.body)) throw new Error("Lead has no brief to promote");
      parseNorthstarDocument(lead.body,"draft");
    }
    else if (cut!.title.length > MAX_TITLE_LENGTH) throw new Error("Task title must be 200 characters or fewer");
    const sourceLanes=(lead??cut)!.lanes;
    const lanes=sourceLanes.filter(key=>{
      const lane=this.context.store.laneByKey(key);
      return lane&&laneListsRepository(lane.repositories,repository.path,repository.origin);
    });
    if (kind==="papercut" && !sourceLanes.length) {
      const project=this.context.store.projectFor(repository.path,repository.origin);
      if (project) {
        const currentPlan=this.context.store.plan({project:project.key});
        if (currentPlan.version>0) {
          const plan=this.context.store.plan({project:project.key,version:currentPlan.version});
          const current=plan.entries.find(entry=>{
            if (entry.horizon!=="now") return false;
            const lane=this.context.store.laneByKey(entry.lane);
            return lane&&(lane.status==="active"||lane.status==="paused")&&laneListsRepository(lane.repositories,repository.path,repository.origin);
          });
          if (current) lanes.push(current.lane);
        }
      }
    }
    const papercutApproval=kind==="papercut"
      ? [input.board ? "operator (board)" : input.agent!.trim(),input.note.trim()].filter(Boolean).join(": ")
      : null;
    const text=lead ? lead.body : `---
title: ${JSON.stringify(cut!.title)}
repository: ${JSON.stringify(repository.origin)}
queue_approval: ${JSON.stringify(papercutApproval)}
queue:
  lanes: ${JSON.stringify(lanes)}${input.complexity ? `\n  complexity: ${input.complexity}` : ""}
---

# ${cut!.title.replace(/\s+/g," ")}

## Happened

${cut!.happened}

## Impact

${cut!.impact}${cut!.fix?`\n\n## Fix\n\n${cut!.fix}`:""}
`;
    if (lead && !hasBriefFrontmatter(text)) throw new Error("Lead has no brief to promote");
    const digest=briefDigest(text);
    if (lead && !this.leadApprovalMatches(lead,digest)) {
      if (input.board) throw new Error("Approve this lead before promotion");
      // Inside an accepted promotion: its acceptance already settled the complexity requirement.
      const refreshed=await this.planning.checkLead({id:lead.id,repository:repository.origin,baseBranch:lead.baseBranch},false);
      if (!refreshed.check?.ok) throw new Error(`Promotion check failed: ${refreshed.check?.message}`);
      this.planning.approveLead({id:lead.id,version:lead.version,digest,approver:input.agent!,note:input.note,relayed:true});
    }
    const expectedApproval=lead?this.context.store.lead(lead.id).approval:null;
    const checked=await this.planning.checkDraft({id:this.planning.sourceBriefId(kind,input.id,repository.origin,digest,lead?.version),text,
      repoPath:repository.path,baseBranch:lead?.baseBranch??"main",originAgentId:lead?this.planning.latestLeadAuthor(lead):(input.board?"operator (board)":input.agent!),attachedLanes:(lead??cut)!.lanes},false);
    if (lead) this.context.store.recordLeadCheck(lead.id,lead.version,{...checked.check,baseBranch:lead.baseBranch});
    if (!checked.check.ok) throw new Error(`Promotion check failed: ${checked.check.message}`);
    const promotedDeclaration=parseNorthstarDocument(text,"draft").queue;
    if(promotedDeclaration.proofOnly){
      const commit=promotedDeclaration.proofOnly.commit;
      const baseBranch=lead?.baseBranch??"main";
      try{
        await git(repository.path,"fetch","--no-tags","origin",`refs/heads/${baseBranch}`);
        await git(repository.path,"merge-base","--is-ancestor",commit,"FETCH_HEAD");
      }catch(error){
        throw new Error(`Proof-only commit ${commit} is not proved as an ancestor of origin/${baseBranch}; promotion refused (${error instanceof Error?error.message:String(error)})`);
      }
    }
    const approvedLead=lead ? this.context.store.lead(lead.id) : null;
    if (approvedLead && (approvedLead.version!==lead!.version || briefDigest(approvedLead.body)!==digest
      || JSON.stringify(approvedLead.approval)!==JSON.stringify(expectedApproval) || !this.leadApprovalMatches(approvedLead,digest)))
      throw new Error("Lead approval no longer matches the checked base branch and head; approve it again");
    // The lead's lanes travel with it: promotion used only brief frontmatter lanes, so tasks from
    // leads filed with `lanes` came out unlaned and their lane read drained while work was live
    // (consumer-b #321, #324, #325, 2026-10-04).
    const promotedLanes=[...new Set([...checked.prepared!.submission.lanes,...lanes])];
    const submission={...checked.prepared!.submission,lanes:promotedLanes,planningSource:{kind,id:input.id},
      ...(approvedLead?.approval?{leadProvenance:{version:approvedLead.version,approval:approvedLead.approval,
        earlierDigests:this.context.store.leadVersionDigestsBeforeLatest(approvedLead.id)}}:{})};
    const expectedSource=papercutDigest??storeDigest(JSON.stringify(this.context.store.lead(input.id)));
    const owner=input.board?OPERATOR_HOLD_OWNER:(input.agent??"").trim();
    const until=input.hold?.until?parseHoldUntil(input.hold.until):null;
    if(input.hold?.until&&!until)throw new Error("A promotion hold's until must be a task ID or an offset timestamp");
    const initial=input.hold?holdPatch({
      held:false,phase:"queued",mergeHold:false,holdOwner:null,holdReason:null,holdAt:null,holdGeneration:0,
      holdUntil:null,holdBlocking:null,originAgentId:owner,holds:{},
    },"dispatch",owner,input.hold.reason,until):{};
    return this.context.engine.submitPlanningSource(submission,{kind,id:input.id,repository:repository.origin,digest,expectedSource},
      {...initial,...(selection ? {hostSelection:selection} : {})},hostId,input.identitySource);
  }
}
