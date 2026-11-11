import { createHash } from "node:crypto";
import type { z } from "zod";
import { type Store, digest as storeDigest, operationIdForKey } from "../store/store";
import { type Engine } from "../engine";
import { git, validateSubmission } from "../git/index";
import type { Submission, Lead } from "../../shared/contracts";
import { OPERATION_COMPATIBILITY_WAIT_MS, operationIsSettled, type OperationAcceptance, type OperationResult } from "../../shared/operations";
import { COMPLEXITY_REQUIRED, complexityRefusal } from "../../shared/demand";
import { leadCheckOperationPayloadSchema, MAX_TITLE_LENGTH, parseHoldUntil, sourcePromotionInputSchema, sourcePromotionOperationPayloadSchema, sourcePromotionOutputSchema, leadSubmit } from "../../shared/contracts";
import { holdPatch, OPERATOR_HOLD_OWNER } from "../merge/merge-hold";
import { validateCompletionRecipients } from '../scheduling/cohort';
import { repositoryOrigin } from "../planning/lanes";
import { briefDigest } from "../planning/brief";
import { now, operationInputHash } from "../store/store";
import { parseNorthstarDocument, prepareDraftContent, proofOnlyPreferenceWarning, reportOnlyDeliveryRefusal } from "../planning/handoff";
import { laneListsRepository, normalizeRepositoryOrigin } from "../../shared/lanes";
import type { Leads } from '../planning/leads';
import type { HostFacade } from "../host/host-facade";

/** Planning dependencies; lifecycle and operation scheduling remain runtime-owned. */
export interface PlanningContext {
  store: Store;
  engine: Pick<Engine, "awaitOperation" | "startOperation" | "scheduleAcceptedOperation" | "submitPlanningSource" | "briefStageProfileRefusal" | "independentReviewRoutingRefusal" | "selectIngressHost" | "hostAvailable" | "startSubmission"> & {
    hooks: Pick<Engine["hooks"], "previewPreDispatch">;
  };
  leads: Leads;
  readonly started: Promise<void>;
  readonly host: Pick<HostFacade, "originAgent">;
  markStoreAccess(): void;
  boardLeadsCache: { revision: number; value: ReturnType<Store["listBoardLeads"]> } | null;
}

export class RuntimePlanning {
  constructor(private readonly context: PlanningContext) {}

  async submitLead(input: z.infer<typeof leadSubmit.input>): Promise<z.infer<typeof leadSubmit.output>> {
    await this.context.started;
    const request = leadSubmit.input.parse(input);
    const repository = this.context.store.resolveRepositoryIdentity(request.repository);
    // The service is the sole writer; lookup and creation run without yielding.
    const source = (() => {
      const existing = this.context.store.findLeadSubmission(request.title, repository);
      if (existing) return existing;
      return { created: this.context.leads.add({ repositories: [repository], title: request.title, body: request.body,
        baseBranch: request.baseBranch, lanes: request.lanes, tags: request.tags, author: request.agent }) };
    })();
    if ("taskId" in source) return { taskId: source.taskId, reference: this.context.store.numberFor(source.taskId)!.reference };
    if ("leadId" in source) return { lead: this.context.store.lead(source.leadId) };
    let lead = await this.checkLeadAfterMutation(source.created);
    if (lead.checkOperationId) {
      const operation = await this.context.engine.awaitOperation(lead.checkOperationId, Infinity);
      if (operation.state !== "succeeded") throw new Error(`Brief check ${operation.id}: ${operation.diagnostic || operation.state}; inspect lead.get before retrying`);
      lead = this.context.store.lead(lead.id);
    }
    if (lead.version !== source.created.version || briefDigest(lead.body) !== briefDigest(request.body))
      throw new Error("Lead changed during submission; reload before approval");
    if (!lead.check) lead = this.recordLeadCheckNotQueued(lead, "Lead has no brief to check");
    if (!lead.check?.ok) return { lead };
    this.approveLead({ id: lead.id, version: lead.version, digest: briefDigest(lead.body),
      approver: request.agent, note: request.note, relayed: true });
    const result = await this.promoteLeadToTask({ id: lead.id, repository: repository.origin, agent: request.agent,
      note: request.note, board: false, ...("hostId" in request ? { hostId: request.hostId } : {}),
      ...("identitySource" in request ? { identitySource: request.identitySource } : {}), hold: request.hold });
    if (!("accepted" in result)) return result;
    const operation = await this.context.engine.awaitOperation(result.operation.id, Infinity);
    if (operation.state === "succeeded" && operation.result?.taskId)
      return { ...this.promotionReply(operation.result.taskId), reference: operation.result.reference ?? "" };
    throw new Error(`Task promotion ${operation.id}: ${operation.diagnostic || operation.state}; inspect lead.get before retrying`);
  }

  async addLead(input: Parameters<Leads["add"]>[0]) {
    const lead = this.context.leads.add(input);
    return this.checkLeadAfterMutation(lead);
  }
  async editLead(input: Parameters<Leads["edit"]>[0]) {
    const current = this.context.store.lead(input.id);
    const baseBranchChanged = input.baseBranch !== undefined && input.baseBranch !== current.baseBranch;
    const lead = this.context.leads.edit(input);
    return !baseBranchChanged && /^---\r?\n/.test(lead.body) && !lead.check ? this.checkLeadAfterMutation(lead) : lead;
  }
  getLead(input: Parameters<Leads["get"]>[0]) { this.context.markStoreAccess(); return this.context.leads.get(input); }
  getLeadSummary(input: Parameters<Leads["getSummary"]>[0]) { this.context.markStoreAccess(); return this.context.leads.getSummary(input); }
  getLeadVersion(input: Parameters<Leads["getVersion"]>[0]) { this.context.markStoreAccess(); return this.context.leads.getVersion(input); }
  listLeads(input: Parameters<Leads["list"]>[0]) { this.context.markStoreAccess(); return this.context.leads.list(input); }
  /**
   * The board's narrow planning-list read: one projection per lead revision, so the surfaces'
   * four-second polls between writes rescan nothing. Every lead, papercut and decision write
   * advances that revision, and a task, run, notice, project or configuration write leaves it
   * alone because `listBoardLeads` derives from no such record.
   */
  leadBoard() {
    this.context.markStoreAccess();
    const revision = this.context.store.leadRevision();
    if (this.context.boardLeadsCache?.revision !== revision) this.context.boardLeadsCache = { revision, value: this.context.store.listBoardLeads() };
    return this.context.boardLeadsCache.value;
  }
  setLeadLanes(input: Parameters<Leads["setLanes"]>[0]) { return this.context.leads.setLanes(input); }
  setLeadTags(input: Parameters<Leads["setTags"]>[0]) { return this.context.leads.setTags(input); }
  dropLead(input: Parameters<Leads["drop"]>[0]) { return this.context.leads.drop(input); }
  // Reopen causes no automatic check, edit, approval, promotion or dispatch; the restored lead keeps its recorded state.
  reopenLead(input: Parameters<Leads["reopen"]>[0]) { return this.context.leads.reopen(input); }
  promoteLead(input: Parameters<Leads["promote"]>[0]) { return this.context.leads.promote(input); }
  async checkLead(input: { id:string; repository?:string; baseBranch?:string }, acceptance = true) {
    await this.context.started;
    const lead = this.context.store.lead(input.id);
    if (!/^---\r?\n/.test(lead.body)) throw new Error("Lead has no brief to check");
    if (input.baseBranch && input.baseBranch !== lead.baseBranch) throw new Error("Edit the lead's baseBranch before checking it");
    const repository = this.selectLeadRepository(lead,input.repository);
    const checked = await this.checkDraft({ id:this.sourceBriefId("lead",lead.id,repository.origin,briefDigest(lead.body)),
      text:lead.body,repoPath:repository.path,baseBranch:lead.baseBranch,originAgentId:this.latestLeadAuthor(lead),attachedLanes:lead.lanes }, acceptance);
    return this.context.store.recordLeadCheck(lead.id,lead.version,{...checked.check,baseBranch:lead.baseBranch});
  }
  private async checkLeadAfterMutation(lead: Lead): Promise<Lead> {
    if (!/^---\r?\n/.test(lead.body)) return lead;
    if (lead.checkOperationId) {
      const existing = this.context.store.operation(lead.checkOperationId);
      if (existing && !operationIsSettled(existing.state)) {
        await this.context.engine.awaitOperation(existing.id, OPERATION_COMPATIBILITY_WAIT_MS).catch(() => existing);
        return this.context.store.lead(lead.id);
      }
    }
    const repository = lead.repositories[0];
    const digest = briefDigest(lead.body);
    const payload = leadCheckOperationPayloadSchema.parse({ type:"lead_check", id:lead.id, version:lead.version, digest, repository:repository.origin, baseBranch:lead.baseBranch });
    const key = `lead-check:${operationInputHash([lead.id,lead.version,digest,repository.origin,lead.baseBranch])}`;
    let acceptance: OperationAcceptance;
    try {
      acceptance = await this.context.engine.startOperation({ key, kind:"lead_check", payload, repoPath:repository.path, deferSchedule:true });
    } catch (error) {
      return this.recordLeadCheckNotQueued(lead,`Brief check could not be queued: ${error instanceof Error ? error.message : String(error)}`);
    }
    if ("backpressured" in acceptance)
      return this.recordLeadCheckNotQueued(lead,`Brief check could not be queued: ${acceptance.reason}`);
    try {
      this.context.store.markLeadCheckPending(lead.id,lead.version,digest,acceptance.operation.id);
    } catch {
      // The accepted check will fail its version fence if the lead moved meanwhile.
    }
    this.context.engine.scheduleAcceptedOperation(acceptance.operation.id);
    await this.context.engine.awaitOperation(acceptance.operation.id, OPERATION_COMPATIBILITY_WAIT_MS).catch(() => undefined);
    return this.context.store.lead(lead.id);
  }
  private recordLeadCheckNotQueued(lead: Lead, message: string): Lead {
    try {
      return this.context.store.recordLeadCheck(lead.id,lead.version,{ok:false,message,checkedAt:now(),planningCommit:null,baseBranch:lead.baseBranch});
    } catch {
      return this.context.store.lead(lead.id);
    }
  }
  async executeLeadCheck(payload: unknown, operationId: string): Promise<OperationResult> {
    await this.context.started;
    const request = leadCheckOperationPayloadSchema.parse(payload);
    let lead = this.context.store.lead(request.id);
    if (lead.version !== request.version || briefDigest(lead.body) !== request.digest)
      throw new Error("Lead changed before brief check; reload");
    if (lead.baseBranch !== request.baseBranch) throw new Error("Lead base branch changed before brief check; reload");
    if (lead.checkOperationId !== operationId) {
      // A process may restart between durable acceptance and recording the
      // operation ID on the lead. Reattach only while this version is unchecked.
      if (lead.checkOperationId || lead.check) throw new Error("Lead check operation changed; reload");
      lead = this.context.store.markLeadCheckPending(lead.id,lead.version,request.digest,operationId);
    }
    if (!/^---\r?\n/.test(lead.body)) throw new Error("Lead has no brief to check");
    const repository = this.selectLeadRepository(lead,request.repository);
    const checked = await this.checkDraft({ id:this.sourceBriefId("lead",lead.id,repository.origin,request.digest),
      text:lead.body,repoPath:repository.path,baseBranch:request.baseBranch,originAgentId:this.latestLeadAuthor(lead),attachedLanes:lead.lanes });
    this.context.store.recordLeadCheck(lead.id,lead.version,{...checked.check,baseBranch:request.baseBranch},operationId);
    return { taskId:null, number:null, taskVersion:lead.version, phase:null, reference:lead.id };
  }
  approveLead(input:{id:string;version:number;digest:string;approver:string;note:string;relayed:boolean}) {
    return this.context.store.transaction(() => {
      const lead = this.context.store.lead(input.id);
      if (lead.state === "dropped" || !/^---\r?\n/.test(lead.body) || lead.version !== input.version
        || briefDigest(lead.body) !== input.digest) throw new Error("Lead version or digest changed; reload before approval");
      if (!lead.check?.ok) throw new Error(`Lead check failed: ${lead.check?.message ?? "Not checked"}`);
      const checkedBaseBranch = lead.check.baseBranch ?? (lead.baseBranch === "main" ? "main" : null);
      if (checkedBaseBranch !== lead.baseBranch || !lead.check.planningCommit)
        throw new Error("Check this lead on its selected base branch before approval");
      if ((!input.relayed && input.approver !== "operator (board)") || (input.relayed && input.approver === "operator (board)"))
        throw new Error("Board approval must use operator (board); relayed approval must identify the agent");
      if (input.relayed && !input.note.trim()) throw new Error("Relayed approval requires an operator authorization note");
      const approval = { version: lead.version, digest: input.digest, approver: input.approver,
        approvedAt: now(), note: input.note, relayed: input.relayed, baseBranch: lead.baseBranch,
        planningCommit: lead.check.planningCommit };
      const updated = this.context.store.updateLead({ ...lead, approval, updatedAt: now() });
      this.context.store.recordLeadApproval(lead.id, lead.version, approval);
      return updated;
    });
  }
  private sourceBriefId(kind:"lead"|"papercut",id:string,repository:string,digest:string,version?:number) {
    return createHash("sha256").update(JSON.stringify([kind,id,repository,digest,...(version ? [version] : [])])).digest("hex");
  }
  private selectLeadRepository(lead: ReturnType<Store["lead"]>, requested?:string) {
    if (lead.repositories.length>1 && !requested) throw new Error("Select one repository for this lead");
    const normalized=requested ? normalizeRepositoryOrigin(requested) ?? requested : lead.repositories[0].origin;
    const repository=lead.repositories.find(repo=>repo.origin===normalized||repo.path===normalized);
    if (!repository) throw new Error("Lead does not list that repository");
    return repository;
  }
  private papercutPromotionRepository(cut: ReturnType<Store["papercut"]>) {
    const origin=cut.repository.origin;
    const registered=this.context.store.projects().flatMap(project=>project.repositories)
      .find(repository=>repository.origin===origin && repository.path.trim());
    const path=registered?.path || this.context.store.repositoryFor(origin)?.repository.path?.trim() || cut.repository.path;
    return {...cut.repository,path};
  }
  private latestLeadAuthor(lead: ReturnType<Store["lead"]>) {
    return this.context.store.leadVersion(lead.id,lead.version).author;
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
  private promotionReply(taskId: string): { taskId: string; hostId?: string; hostSelection?: import('../../shared/host-selection').HostSelection } {
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
    if (!request.board && (!request.agent?.trim() || !request.note.trim())) throw new Error("Agent promotion requires an agent and operator authorization note");
    if (request.board && request.agent) throw new Error("Board promotion records operator (board), without an agent");
    const lead=kind==="lead"?this.context.store.lead(request.id):null;
    const cut=kind==="papercut"?this.context.store.papercut(request.id):null;
    if (lead?.state==="dropped" || cut?.state==="closed") throw new Error("Source is closed");
    if (lead && request.baseBranch && request.baseBranch!==lead.baseBranch) throw new Error("Edit the lead's baseBranch before promotion");
    if (cut && request.baseBranch && request.baseBranch!=="main") throw new Error("Papercut promotion uses main");
    const repository=lead?this.selectLeadRepository(lead,request.repository):this.papercutPromotionRepository(cut!);
    const sourceDigest=lead
      ? storeDigest(JSON.stringify([lead.version,briefDigest(lead.body)]))
      : storeDigest(JSON.stringify(cut));
    const existing=this.context.store.sourcePromotionResult({kind,id:request.id},repository.origin,lead?.version??null,sourceDigest);
    if (existing) return {...this.promotionReply(existing.taskId!),reference:existing.reference!};
    if (lead) {
      if (!/^---\r?\n/.test(lead.body)) throw new Error("Lead has no brief to promote");
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
    if (!input.board && (!input.agent?.trim() || !input.note.trim())) throw new Error("Agent promotion requires an agent and operator authorization note");
    if (input.board && input.agent) throw new Error("Board promotion records operator (board), without an agent");
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
    const repository=lead?this.selectLeadRepository(lead,input.repository):this.papercutPromotionRepository(cut!);
    const currentDigest=lead
      ? storeDigest(JSON.stringify([lead.version,briefDigest(lead.body)]))
      : storeDigest(JSON.stringify(cut));
    if (source.version!==(lead?.version??null) || currentDigest!==source.digest)
      throw new Error(`${kind==="lead"?"Lead":"Papercut"} changed during promotion; reload`);
    if (lead && source.approval!==undefined && JSON.stringify(source.approval)!==JSON.stringify(lead.approval))
      throw new Error("Lead approval changed while promotion was queued; reload");
    if (lead) {
      if (!/^---\r?\n/.test(lead.body)) throw new Error("Lead has no brief to promote");
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
    if (lead && !/^---\r?\n/.test(text)) throw new Error("Lead has no brief to promote");
    const digest=briefDigest(text);
    if (lead && !this.leadApprovalMatches(lead,digest)) {
      if (input.board) throw new Error("Approve this lead before promotion");
      // Inside an accepted promotion: its acceptance already settled the complexity requirement.
      const refreshed=await this.checkLead({id:lead.id,repository:repository.origin,baseBranch:lead.baseBranch},false);
      if (!refreshed.check?.ok) throw new Error(`Promotion check failed: ${refreshed.check?.message}`);
      this.approveLead({id:lead.id,version:lead.version,digest,approver:input.agent!,note:input.note,relayed:true});
    }
    const expectedApproval=lead?this.context.store.lead(lead.id).approval:null;
    const checked=await this.checkDraft({id:this.sourceBriefId(kind,input.id,repository.origin,digest,lead?.version),text,
      repoPath:repository.path,baseBranch:lead?.baseBranch??"main",originAgentId:lead?this.latestLeadAuthor(lead):(input.board?"operator (board)":input.agent!),attachedLanes:(lead??cut)!.lanes},false);
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
  importLeads(input: Parameters<Leads["import"]>[0]) { return this.context.leads.import(input); }
  getLaneDocument(input: { key: string; version?: number }) {
    this.context.markStoreAccess();
    if (!this.context.store.laneByKey(input.key)) throw new Error(`Unknown lane key ${input.key}`);
    const document = this.context.store.laneDocument(input.key, input.version);
    if (!document && input.version) throw new Error(`Lane document ${input.key} has no version ${input.version}`);
    return document;
  }
  editLaneDocument(input: Parameters<Store["editLaneDocument"]>[0]) { return this.context.store.editLaneDocument(input); }
  getPlan(input: Parameters<Store["plan"]>[0]) { this.context.markStoreAccess(); return this.context.store.plan(input); }
  listPlans() { this.context.markStoreAccess(); return this.context.store.plans(); }
  setPlan(input: Parameters<Store["setPlan"]>[0]) { return this.context.store.setPlan(input); }

  /**
   * Spec 053: a new submission must name its complexity. A replay of an
   * operation Queue already accepted keeps its original acceptance.
   */
  requireComplexityOnFirstAcceptance(submission: { complexity?: Submission["complexity"] }, key: string) {
    if (this.context.store.operation(operationIdForKey(key))) return;
    const refusal = complexityRefusal(submission);
    if (refusal) throw new Error(refusal);
  }

  upsertLane(input: import("../../shared/contracts").LaneUpsertInput) { return this.context.store.upsertLane(input); }
  setLaneStatus(input: { key: string; status: import("../../shared/contracts").Lane["status"]; note?: string }) {
    return this.context.store.setLaneStatus(input.key, input.status, input.note ?? "");
  }
  keepLane(input: { key: string; reason: string; author?: string }) {
    return this.context.store.keepLane({ key: input.key, reason: input.reason, author: input.author ?? "operator" });
  }
  listLanes(input: { status?: import("../../shared/contracts").Lane["status"]; repository?: string } = {}) {
    this.context.markStoreAccess();
    return this.context.store.laneViews(input);
  }
  /**
   * `acceptance` is true for a new check or promotion acceptance. Executing a
   * promotion Queue already accepted passes false: an operation accepted before
   * Spec 053 required complexity still replays (review #597).
   */
  private async checkDraft(input:{id:string;text:string;repoPath:string;baseBranch:string;originAgentId:string;attachedLanes?:string[]}, acceptance = true) {
    let prepared: Awaited<ReturnType<typeof prepareDraftContent>> | null = null;
    try {
      const repository = await repositoryOrigin(input.repoPath) ?? input.repoPath;
      prepared = await prepareDraftContent({text:input.text,repoPath:input.repoPath,baseBranch:input.baseBranch,originAgentId:input.originAgentId,draftId:input.id});
      const submission = prepared.submission;
      // Spec 053: a brief names its complexity before it can be checked, approved or promoted.
      const missingComplexity = acceptance ? complexityRefusal(submission) : null;
      if (missingComplexity) throw new Error(missingComplexity);
      // Spec 043: a declared stage profile is preflighted here too, so a brief check
      // reports an unusable profile before approval or dispatch ever reads it.
      const stageProfileRefusal = this.context.engine.briefStageProfileRefusal(input.text, submission.scope);
      if (stageProfileRefusal) throw new Error(stageProfileRefusal);
      const routingConflict = this.context.engine.independentReviewRoutingRefusal(submission);
      if (routingConflict) throw new Error(routingConflict);
      this.context.store.validateDependencies(submission);
      const origin = await repositoryOrigin(submission.repoPath);
      this.context.store.requireSubmissionLanes(submission,origin);
      const honour = reportOnlyDeliveryRefusal(input.text, [...submission.lanes, ...(input.attachedLanes ?? [])]);
      if (honour) throw new Error(honour);
      if (submission.notifyOriginOnCloseout || submission.completionNotificationAgentIds.length)
        await validateCompletionRecipients(submission,id=>this.context.host.originAgent(id));
      await this.context.engine.hooks.previewPreDispatch(submission,input.text,prepared.planningCommit);
      const warning = prepared.warning ?? proofOnlyPreferenceWarning(submission);
      const preferenceWarning = warning ? ` Warning: ${warning}` : "";
      return { prepared, check:{ok:true,message:`Ready.${preferenceWarning}`,checkedAt:now(),planningCommit:prepared.planningCommit} };
    } catch (error) {
      return { prepared, check:{ok:false,message:error instanceof Error?error.message:String(error),checkedAt:now(),planningCommit:prepared?.planningCommit ?? null} };
    }
  }

  async submitHandoff(input: import("../planning/handoff").HandoffInput) {
    await this.context.started;
    const { captureHandoff } = await import("../planning/handoff");
    const prepared = await captureHandoff(input);
    if (input.hostId) prepared.submission = { ...prepared.submission, hostId: input.hostId };
    if (input.dryRun) {
      const hostId = this.context.engine.selectIngressHost(input.hostId, prepared.submission.repoPath);
      if (!hostId || !this.context.engine.hostAvailable(hostId)) throw new Error('Selected submission host is unavailable');
      const { verifyPublishedPlanning } = await import("../git/index");
      await verifyPublishedPlanning(prepared.submission);
      const validated = await validateSubmission(prepared.submission);
      const routingConflict = this.context.engine.independentReviewRoutingRefusal(prepared.submission);
      if (routingConflict) throw new Error(routingConflict);
      const needsRecipients = prepared.submission.notifyOriginOnCloseout || prepared.submission.completionNotificationAgentIds.length > 0;
      if (needsRecipients) await validateCompletionRecipients(prepared.submission, id => this.context.host.originAgent(id));
      if (!this.context.store.existing(prepared.submission)) this.context.store.validateDependencies(prepared.submission);
      if (prepared.submission.lanes.length || prepared.submission.laneDocuments?.length) {
        this.context.store.requireSubmissionLanes(prepared.submission, await repositoryOrigin(prepared.submission.repoPath));
      }
      await this.context.engine.hooks.previewPreDispatch(prepared.submission, validated.handoffText, validated.planningBase);
      return { ...prepared, task: null, operation: null };
    }
    this.requireComplexityOnFirstAcceptance(prepared.submission, `submit:${prepared.submission.submissionId}`);
    const acceptance = await this.context.engine.startSubmission(prepared.submission, true);
    if ("backpressured" in acceptance) return acceptance;
    const operation = acceptance.operation;
    return { ...prepared, task: operation.state === "succeeded" && operation.result?.taskId ? this.context.store.task(operation.result.taskId) : null, operation };
  }
}
