import { assertSubmissionRouting } from "./submission-routing";
import type { Task, Submission } from "../../shared/contracts";
import type { QueueOperation, OperationResult } from "../../shared/operations";
import type { IdentitySource } from "../../shared/host-kind";
import { isTransportFailure } from "../../shared/transport";
import { validateCompletionRecipients } from "../scheduling/cohort";
import type { Engine } from "../engine";
import { SubmissionUnavailableError, validateSubmission, verifyPublishedPlanning } from "../git/index";
import { isStaleIntegrationBaseRefusal } from "../hooks/hooks";
import { repositoryOrigin } from "./lanes";
import { STEPS_RETIRED_REASON } from "../recovery/retired-steps";
import { stageDeclarationFromBrief } from "../stages";

/** Reject retired submission controls before accepting or executing intake. */
export function assertSupportedSubmission(submission: Submission): void {
    if (submission.responsible === false) throw new Error("responsible: false is no longer supported; every task runs the responsible lifecycle");
    if (submission.manualVerification === true) throw new Error("manualVerification is no longer available; every task runs the responsible lifecycle");
    if (submission.reviewVerdicts !== undefined || submission.reviewPassGate !== undefined) throw new Error("reviewVerdicts and reviewPassGate are no longer available; state the outcome and acceptance in prose in the brief, and use mergeHold for a needed hold");
}

/** Validates and commits one accepted submission or source promotion. */
export class PlanningSubmission {
  constructor(private readonly engine: Engine) {}
  private get store() { return this.engine.store; }
  private get hooks() { return this.engine.hooks; }
  async performSubmit(submission: Submission, requirePushedPlanning = false, promotion?: {source:{kind:"lead"|"papercut";id:string;repository:string;digest:string;expectedSource:string}; initial?: Partial<Task>; identitySource?: IdentitySource}, hostId?: string, hostSelection?: QueueOperation['hostSelection']): Promise<OperationResult> {
    const originForSelection = promotion?.source.repository ?? await repositoryOrigin(submission.repoPath).catch(() => null);
    hostId ??= this.engine.selectIngressHost(submission.hostId, submission.repoPath, originForSelection);
    // A replay after a lost response resolves the durable submission identity
    // before any remote validation or insertion.
    const existing = promotion ? null : this.store.existing(submission);
    if (existing) return { taskId: existing.id, taskVersion: existing.version, phase: existing.phase, number: existing.number, reference: existing.reference };
    assertSupportedSubmission(submission);
    if (submission.brief && stageDeclarationFromBrief(submission.brief.text)) throw new Error(STEPS_RETIRED_REASON);
    const origin = await repositoryOrigin(submission.repoPath);
    if (requirePushedPlanning) await verifyPublishedPlanning(submission);
    const validated = await validateSubmission(submission);
    const raced = promotion ? null : this.store.existing(submission);
    if (raced) return { taskId: raced.id, taskVersion: raced.version, phase: raced.phase, number: raced.number, reference: raced.reference };
    this.store.requireSubmissionLanes(submission, origin);
    assertSubmissionRouting(this.engine, submission);
    // Resolving recipients is a live agent lookup, so only a submission that actually
    // notifies needs it. Doing it unconditionally put a daemon round trip - and its 15 s
    // liveness timeout - in front of every accepted handoff, so a flapping transport failed
    // the submission and left no task at all.
    const needsRecipients = Boolean(submission.notifyOriginOnCloseout) || submission.completionNotificationAgentIds.length > 0;
    // The origin identity's own source proved its host; it is evidence about that
    // identity only, so an offline host that has no part in it cannot turn a
    // decidable origin into an ambiguous one.
    const originIdentity = promotion?.identitySource ?? submission.originIdentity;
    const originHostId = await this.engine.identifyOriginHost(submission.originAgentId, originIdentity);
    if (needsRecipients && !originHostId) throw new SubmissionUnavailableError("Origin host is unknown or ambiguous");
    const resolved = needsRecipients ? await validateCompletionRecipients(submission, async id => {
      const identitySource = id === submission.originAgentId ? originIdentity : undefined;
      const host = await this.engine.identifyOriginHost(id, identitySource);
      if (!host) throw new SubmissionUnavailableError("Completion recipient host is unknown or ambiguous");
      return this.engine.withHost(host, () => this.engine.host.originAgent(id));
    }) : null;
    // A parsed refusal is a ruling and stops the submission. An operational failure - the
    // transport, a stale integration base - is not: the task is created queued and the same
    // hook runs again at dispatch.
    try {
      await this.hooks.previewPreDispatch(submission, validated.handoffText, validated.planningBase);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (!isTransportFailure(error) && !isStaleIntegrationBaseRefusal(message)) throw error;
    }
    const initial = {
      ...(resolved ? { creatorCompletionRecipients: resolved.recipients } : {}),
      ...(promotion ? promotion.initial ?? {} : {}),
      ...(hostSelection ? { hostSelection } : {}),
      originHostId,
    };
    const inserted = promotion
      ? this.store.promoteSource({kind:promotion.source.kind,id:promotion.source.id},promotion.source.repository,promotion.source.digest,promotion.source.expectedSource,submission,hostId ?? "",validated.planningBase,origin,initial)
      : this.store.insert(submission, hostId ?? "", validated.handoffText, validated.planningBase, initial, undefined, origin);
    if ("taskId" in inserted) return inserted;
    const task = this.store.update(inserted.id, { originWorkspaceId: resolved?.origin?.workspaceId ?? null });
    void this.engine.cleanContext(() => this.engine.wakeTask(task.id));
    void this.engine.cleanContext(() => this.engine.wakeRepository(task.repoPath));
    return { taskId: task.id, taskVersion: task.version, phase: task.phase, number: task.number, reference: task.reference };
  }
}
