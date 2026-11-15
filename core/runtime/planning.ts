import { PlanningPromotion } from "./planning-promotion";
import { PlanningSubmission } from "./planning-submission";
import { createHash } from "node:crypto";
import type { z } from "zod";
import { type Store } from "../store/store";
import { type Engine } from "../engine";
import type { Lead } from "../../shared/contracts";
import { OPERATION_COMPATIBILITY_WAIT_MS, operationIsSettled, type OperationAcceptance, type OperationResult } from "../../shared/operations";
import { leadCheckOperationPayloadSchema, leadSubmit } from "../../shared/contracts";
import { briefDigest, hasBriefFrontmatter } from "../planning/brief";
import { now, operationInputHash } from "../store/store";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import type { Leads } from '../planning/leads';
import type { HostFacade } from "../host/host-facade";

/** Planning dependencies; lifecycle and operation scheduling remain runtime-owned. */
export interface PlanningContext {
  store: Store;
  engine: Pick<Engine, "awaitOperation" | "startOperation" | "scheduleAcceptedOperation" | "submitPlanningSource" | "briefStageProfileRefusal" | "independentReviewRoutingRefusal" | "selectIngressHost" | "hostAvailable" | "startSubmission"> & {
    hooks: Pick<Engine["hooks"], "previewPreDispatch">;
    identifyOriginHost(agentId: string, identitySource?: import("../../shared/host-kind").IdentitySource): Promise<string | undefined>;
    withHost<T>(hostId: string, work: () => T): T;
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
    if ("taskId" in source) return { ...this.promotion.promotionReply(source.taskId), reference: this.context.store.numberFor(source.taskId)!.reference };
    if ("leadId" in source) return { lead: this.context.store.lead(source.leadId) };
    let lead = await this.checkLeadAfterMutation(source.created);
    if (lead.checkOperationId) {
      const operation = await this.context.engine.awaitOperation(lead.checkOperationId, OPERATION_COMPATIBILITY_WAIT_MS);
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
    const operation = await this.context.engine.awaitOperation(result.operation.id, OPERATION_COMPATIBILITY_WAIT_MS);
    if (operation.state === "succeeded" && operation.result?.taskId)
      return { ...this.promotion.promotionReply(operation.result.taskId), reference: operation.result.reference ?? "" };
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
    return !baseBranchChanged && hasBriefFrontmatter(lead.body) && !lead.check ? this.checkLeadAfterMutation(lead) : lead;
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
    if (!hasBriefFrontmatter(lead.body)) throw new Error("Lead has no brief to check");
    if (input.baseBranch && input.baseBranch !== lead.baseBranch) throw new Error("Edit the lead's baseBranch before checking it");
    const repository = this.selectLeadRepository(lead,input.repository);
    const checked = await this.checkDraft({ id:this.sourceBriefId("lead",lead.id,repository.origin,briefDigest(lead.body)),
      text:lead.body,repoPath:repository.path,baseBranch:lead.baseBranch,originAgentId:this.latestLeadAuthor(lead),attachedLanes:lead.lanes }, acceptance);
    return this.context.store.recordLeadCheck(lead.id,lead.version,{...checked.check,baseBranch:lead.baseBranch});
  }
  private async checkLeadAfterMutation(lead: Lead): Promise<Lead> {
    if (!hasBriefFrontmatter(lead.body)) return lead;
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
    if (!hasBriefFrontmatter(lead.body)) throw new Error("Lead has no brief to check");
    const repository = this.selectLeadRepository(lead,request.repository);
    const checked = await this.checkDraft({ id:this.sourceBriefId("lead",lead.id,repository.origin,request.digest),
      text:lead.body,repoPath:repository.path,baseBranch:request.baseBranch,originAgentId:this.latestLeadAuthor(lead),attachedLanes:lead.lanes });
    this.context.store.recordLeadCheck(lead.id,lead.version,{...checked.check,baseBranch:request.baseBranch},operationId);
    return { taskId:null, number:null, taskVersion:lead.version, phase:null, reference:lead.id };
  }
  approveLead(input:{id:string;version:number;digest:string;approver:string;note:string;relayed:boolean}) {
    return this.context.store.transaction(() => {
      const lead = this.context.store.lead(input.id);
      if (lead.state === "dropped" || !hasBriefFrontmatter(lead.body) || lead.version !== input.version
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
  sourceBriefId(kind:"lead"|"papercut",id:string,repository:string,digest:string,version?:number) {
    return createHash("sha256").update(JSON.stringify([kind,id,repository,digest,...(version ? [version] : [])])).digest("hex");
  }
  selectLeadRepository(lead: ReturnType<Store["lead"]>, requested?:string) {
    if (lead.repositories.length>1 && !requested) throw new Error("Select one repository for this lead");
    const normalized=requested ? normalizeRepositoryOrigin(requested) ?? requested : lead.repositories[0].origin;
    const repository=lead.repositories.find(repo=>repo.origin===normalized||repo.path===normalized);
    if (!repository) throw new Error("Lead does not list that repository");
    return repository;
  }
  latestLeadAuthor(lead: ReturnType<Store["lead"]>) {
    return this.context.store.leadVersion(lead.id,lead.version).author;
  }
  private get promotion() { return new PlanningPromotion(this.context, this); }
  private get submission() { return new PlanningSubmission(this.context); }
  promoteLeadToTask(input: Parameters<PlanningPromotion["promoteLeadToTask"]>[0]) { return this.promotion.promoteLeadToTask(input); }
  promotePapercutToTask(input: Parameters<PlanningPromotion["promotePapercutToTask"]>[0]) { return this.promotion.promotePapercutToTask(input); }
  executeSourcePromotion(...args: Parameters<PlanningPromotion["executeSourcePromotion"]>) { return this.promotion.executeSourcePromotion(...args); }
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

  requireComplexityOnFirstAcceptance(...args: Parameters<PlanningSubmission["requireComplexityOnFirstAcceptance"]>) {
    return this.submission.requireComplexityOnFirstAcceptance(...args);
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
  checkDraft(...args: Parameters<PlanningSubmission["checkDraft"]>) { return this.submission.checkDraft(...args); }
  submitHandoff(...args: Parameters<PlanningSubmission["submitHandoff"]>) { return this.submission.submitHandoff(...args); }
}
