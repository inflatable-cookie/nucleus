import type { DatabaseSync } from "node:sqlite";
import type { Lead,Outcome,Papercut,Submission,Task } from "../../shared/contracts";
import type { OperationResult } from "../../shared/operations";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { briefDigest } from "../planning/brief";
import { STEPS_RETIRED_REASON } from "../recovery/retired-steps";
import { stageDeclarationFromBrief } from "../stages";
import { digest,now } from "./store-core";

/** The store services source promotion calls; none of them starts another write funnel. */
export interface SourcePromotionServices {
  readonly db: DatabaseSync;
  transaction<T>(fn: () => T): T;
  lead(id: string): Lead;
  leadVersionOrNull(id: string, version: number): import("../../shared/contracts").LeadVersion | null;
  leadVersionDigestsBeforeLatest(id: string): string[];
  papercut(id: string): Papercut;
  updateLead(lead: Lead): Lead;
  updatePapercut(record: Papercut): Papercut;
  outcome(taskId: string): Outcome | null;
  numberedTask(data: string): Task;
  existing(input: Submission): Task | null;
  insert(input: Submission, hostId: string, handoffText: string, planningBase: string, initial?: Partial<Task>, credential?: undefined, origin?: string | null): Task;
  update(id: string, change: Partial<Task>, kind?: string, detail?: string): Task;
  /** The review-entry brief admission, owned beside promotion because it reads the same source. */
  validateReviewEntryBrief(input: Submission, githubRepository: string): void;
}

/**
 * Source promotion: the one place a lead or papercut becomes a task, and the review-entry
 * brief admission that must read the same approved source. The source link and the task
 * admission commit together, so a retry resolves the same task and never a second one.
 */
export class StoreSourcePromotion {
  constructor(private readonly services: SourcePromotionServices) {}

  /** Resolve only the admitted version, using immutable task/outcome approval, never today's check. */
  sourcePromotionResult(source: { kind: "lead" | "papercut"; id: string }, repository: string,
    version: number | null, sourceDigest: string): OperationResult | null {
    const lead = this.services.lead(source.id);
    const targets = lead.targets.filter(target => target.kind === "task" && target.repository === repository);
    let selected: OperationResult | null = null;
    for (const target of targets) {
      const outcome = this.services.outcome(target.reference);
      const row = this.services.db.prepare("SELECT data FROM tasks WHERE id=?").get(target.reference);
      const task = row ? this.services.numberedTask(String(row.data)) : null;
      const ambiguous = () => new Error(`Cannot establish admitted lead version for task ${target.reference}; promotion refused`);
      if (!task && !outcome) throw ambiguous();
      // Papercuts have one task identity even when their metadata changes or the lead API reads them.
      if (source.kind === "lead" && !lead.papercut) {
        const provenance = task?.leadProvenance;
        const approval = provenance?.approval ?? outcome?.brief.approval;
        const recordSource = task?.planningSource ?? outcome?.planningSource;
        const recordRepository = task?.repository ?? outcome?.repository.origin;
        const recordPath = task?.repoPath ?? outcome?.repository.path;
        const member = lead.repositories.find(repo => repo.origin === repository);
        if (!approval || recordSource?.kind !== "lead" || recordSource.id !== source.id
          || (recordRepository !== repository && recordPath !== member?.path)
          || (provenance && provenance.version !== approval.version)) throw ambiguous();
        const saved = this.services.leadVersionOrNull(source.id, approval.version);
        if (!saved || briefDigest(saved.body) !== approval.digest
          || (outcome?.brief.approval && JSON.stringify(outcome.brief.approval) !== JSON.stringify(approval))) throw ambiguous();
        if (approval.version !== version) continue;
        if (digest(JSON.stringify([approval.version, approval.digest])) !== sourceDigest) throw ambiguous();
      }
      const result: OperationResult = outcome
        ? { taskId: outcome.taskId, number: outcome.number, reference: outcome.reference, taskVersion: null, phase: null }
        : { taskId: task!.id, number: task!.number, reference: task!.reference, taskVersion: task!.version, phase: task!.phase };
      if (!result.reference || (selected && selected.taskId !== result.taskId)) throw ambiguous();
      selected = result;
    }
    return selected;
  }
  /** Source link and task admission commit together; retries resolve the same task. */
  promoteSource(source: { kind: "lead" | "papercut"; id: string }, repository: string, approvedDigest: string, expectedSource: string,
    submission: Submission, hostId: string, planningBase: string, origin: string | null, initial: Partial<Task> = {}): Task | OperationResult {
    return this.services.transaction(() => {
      const provenance = submission.leadProvenance;
      const existing = this.sourcePromotionResult(source, repository, provenance?.version ?? null,
        digest(JSON.stringify([provenance?.version, approvedDigest])));
      if (existing) return existing;
      if (submission.planningSource?.kind !== source.kind || submission.planningSource.id !== source.id
        || !submission.brief || briefDigest(submission.brief.text) !== approvedDigest)
        throw new Error("Promotion submission does not match its source brief");
      if (this.services.existing(submission)) throw new Error("Promotion submission already exists without its source binding");
      if (source.kind === "lead") {
        const lead = this.services.lead(source.id);
        if (digest(JSON.stringify(lead)) !== expectedSource) throw new Error("Lead changed during promotion; reload");
        const approvalBaseBranch = lead.approval?.baseBranch ?? (lead.baseBranch === "main" ? "main" : null);
        const approvalHead = lead.approval?.planningCommit ?? (lead.baseBranch === "main" ? lead.check?.planningCommit : null);
        if (lead.state === "dropped" || !lead.repositories.some(repo => repo.origin === repository)
          || !provenance || provenance.version !== lead.version
          || JSON.stringify(provenance.approval) !== JSON.stringify(lead.approval)
          || submission.planningSource?.kind !== source.kind || submission.planningSource.id !== source.id
          || !lead.approval || lead.approval.version !== lead.version || lead.approval.digest !== approvedDigest
          || `sha256:${digest(lead.body)}` !== approvedDigest || !lead.check?.ok
          || lead.baseBranch !== submission.baseBranch || lead.check.baseBranch !== submission.baseBranch
          || lead.check.planningCommit !== submission.planningCommit
          || approvalBaseBranch !== submission.baseBranch || approvalHead !== submission.planningCommit)
          throw new Error("Lead approval or check changed before promotion");
        const task = this.services.insert(submission, hostId, lead.body, planningBase, { ...initial, papercutTask: lead.tags.includes("papercut") }, undefined, origin);
        const stamp = now();
        this.services.updateLead({ ...lead, state: "promoted", targets: [...lead.targets,
          { kind: "task", repository, reference: task.id, at: stamp }], updatedAt: stamp, closedAt: lead.closedAt ?? stamp });
        return task;
      }
      const cut = this.services.papercut(source.id);
      if (digest(JSON.stringify(cut)) !== expectedSource) throw new Error("Papercut changed during promotion; reload");
      if (cut.state !== "open" || `sha256:${digest(submission.brief!.text)}` !== approvedDigest)
        throw new Error("Papercut changed before promotion");
      const task = this.services.insert(submission, hostId, submission.brief!.text, planningBase, initial, undefined, origin);
      this.services.updatePapercut({ ...cut, state: "promoted", taskId: task.id, draftId: null });
      return task;
    });
  }
  /** A review entry may bind only a Queue-held brief whose exact checked approval still exists. */
  validateReviewEntryBrief(input: Submission, githubRepository: string): void {
    if (!input.brief) return;
    if (stageDeclarationFromBrief(input.brief.text)) throw new Error(STEPS_RETIRED_REASON);
    const expectedDigest = briefDigest(input.brief.text);
    if (input.brief.digest && input.brief.digest !== expectedDigest) throw new Error("Queue-held brief digest changed");
    const expectedOrigin = normalizeRepositoryOrigin(`https://github.com/${githubRepository}`);
    const matchesRepository = (repository: {origin:string|null;path:string}) => repository.path === input.repoPath
      && Boolean(repository.origin && normalizeRepositoryOrigin(repository.origin) === expectedOrigin);
    // The retired draft record can only refuse. It never authorizes review entry.
    if (input.draftProvenance) {
      if (input.leadProvenance) throw new Error("Queue-held brief has conflicting approval records");
      throw new Error("Queue-held brief draft approval, check or planning identity changed");
    }
    const source = input.planningSource, provenance = input.leadProvenance;
    if (!source || source.kind !== "lead" || !provenance) throw new Error("Review entry requires a checked Queue-held brief approval");
    const lead = this.services.lead(source.id), earlierDigests = this.services.leadVersionDigestsBeforeLatest(source.id);
    const approvalBaseBranch = lead.approval?.baseBranch ?? (lead.baseBranch === "main" ? "main" : null);
    const approvalHead = lead.approval?.planningCommit ?? (lead.baseBranch === "main" ? lead.check?.planningCommit : null);
    if (lead.state !== "open" || !lead.approval || !lead.check?.ok || !lead.repositories.some(matchesRepository)
      || lead.baseBranch !== input.baseBranch || (lead.originAgentId && lead.originAgentId !== input.originAgentId)
      || approvalBaseBranch !== input.baseBranch || approvalHead !== input.planningCommit
      || lead.version !== provenance.version || lead.approval.version !== provenance.version
      || lead.approval.digest !== expectedDigest || lead.digest !== expectedDigest || lead.body !== input.brief.text
      || JSON.stringify(lead.approval) !== JSON.stringify(provenance.approval)
      || JSON.stringify(earlierDigests) !== JSON.stringify(provenance.earlierDigests)
      || lead.check.planningCommit !== input.planningCommit)
      throw new Error("Queue-held brief lead approval, check or planning identity changed");
  }
  /** Consume the approved source and link it to the review task in its binding transaction. */
  claimReviewEntryBrief(input: Submission, githubRepository: string, taskId: string): void {
    if (!input.brief) return;
    this.validateReviewEntryBrief(input, githubRepository);
    // Validation above admits only a lead source.
    if (this.services.lead(input.planningSource!.id).tags.includes("papercut"))
      this.services.update(taskId, { papercutTask: true }, "papercut_source_claimed", input.planningSource!.id);
    const source = input.planningSource!, lead = this.services.lead(source.id), stamp = now();
    const repository = lead.repositories.find(matches => matches.path === input.repoPath)!.origin;
    this.services.updateLead({ ...lead, state:"promoted", targets:[...lead.targets,
      {kind:"task",repository,reference:taskId,at:stamp}], updatedAt:stamp, closedAt:lead.closedAt ?? stamp });
  }

}
