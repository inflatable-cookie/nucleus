import { assertSubmissionRouting } from "../planning/submission-routing";
import { now, operationIdForKey } from "../store/store";
import type { Submission } from "../../shared/contracts";
import { complexityRefusal } from "../../shared/demand";
import { validateCompletionRecipients } from "../scheduling/cohort";
import { ProtocolError } from "../../shared/service/protocol";
import { repositoryOrigin } from "../planning/lanes";
import {
  prepareDraftContent,
  proofOnlyPreferenceWarning,
  reportOnlyDeliveryRefusal,
} from "../planning/handoff";
import { validateSubmission } from "../git/index";
import { assertBbSubmissionIngressAvailable } from "../planning/submission-routing";
import type { PlanningContext } from "./planning";
import type { IdentitySource } from "../../shared/host-kind";

/** Owns draft and handoff preparation before the runtime accepts planning work. */
export class PlanningSubmission {
  constructor(private readonly context: PlanningContext) {}

  requireComplexityOnFirstAcceptance(
    submission: { complexity?: Submission["complexity"] },
    key: string,
  ) {
    if (this.context.store.operation(operationIdForKey(key))) return;
    const refusal = complexityRefusal(submission);
    if (refusal) throw new Error(refusal);
  }

  /**
   * `acceptance` is true for a new check or promotion acceptance. Executing a
   * promotion Queue already accepted passes false: an operation accepted before
   * Spec 053 required complexity still replays (review #597).
   */
  async checkDraft(
    input: {
      id: string;
      text: string;
      repoPath: string;
      baseBranch: string;
      originAgentId: string;
      attachedLanes?: string[];
      originIdentity?: IdentitySource;
    },
    acceptance = true,
  ) {
    let prepared: Awaited<ReturnType<typeof prepareDraftContent>> | null = null;
    try {
      const repository =
        (await repositoryOrigin(input.repoPath)) ?? input.repoPath;
      prepared = await prepareDraftContent({
        text: input.text,
        repoPath: input.repoPath,
        baseBranch: input.baseBranch,
        originAgentId: input.originAgentId,
        draftId: input.id,
      });
      // The caller's proven identity decides the origin host of a check, as it does for a submission.
      const submission = input.originIdentity
        ? { ...prepared.submission, originIdentity: input.originIdentity }
        : prepared.submission;
      const missingComplexity = acceptance
        ? complexityRefusal(submission)
        : null;
      if (missingComplexity) throw new Error(missingComplexity);
      const stageProfileRefusal = this.context.engine.briefStageProfileRefusal(
        input.text,
        submission.scope,
      );
      if (stageProfileRefusal) throw new Error(stageProfileRefusal);
      assertSubmissionRouting(this.context.engine, submission);
      this.context.store.validateDependencies(submission);
      const origin = await repositoryOrigin(submission.repoPath);
      this.context.store.requireSubmissionLanes(submission, origin);
      const honour = reportOnlyDeliveryRefusal(input.text, [
        ...submission.lanes,
        ...(input.attachedLanes ?? []),
      ]);
      if (honour) throw new Error(honour);
      if (
        submission.notifyOriginOnCloseout ||
        submission.completionNotificationAgentIds.length
      )
        await validateCompletionRecipients(submission, (id) =>
          this.lookupCompletionRecipient(id, submission),
        );
      await this.context.engine.hooks.previewPreDispatch(
        submission,
        input.text,
        prepared.planningCommit,
      );
      const warning =
        prepared.warning ?? proofOnlyPreferenceWarning(submission);
      const preferenceWarning = warning ? ` Warning: ${warning}` : "";
      return {
        prepared,
        check: {
          ok: true,
          message: `Ready.${preferenceWarning}`,
          checkedAt: now(),
          planningCommit: prepared.planningCommit,
        },
      };
    } catch (error) {
      return {
        prepared,
        check: {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          checkedAt: now(),
          planningCommit: prepared?.planningCommit ?? null,
        },
      };
    }
  }

  async submitHandoff(input: import("../planning/handoff").HandoffInput) {
    await this.context.started;
    const { captureHandoff } = await import("../planning/handoff");
    const prepared = await captureHandoff(input);
    if (input.hostId)
      prepared.submission = { ...prepared.submission, hostId: input.hostId };
    prepared.submission = this.context.store.resolveSubmissionDependencies(
      prepared.submission,
    );
    if (input.dryRun) {
      const origin = await repositoryOrigin(prepared.submission.repoPath).catch(
        () => null,
      );
      assertBbSubmissionIngressAvailable(
        this.context.engine,
        input.hostId,
        prepared.submission.originIdentity?.hostId,
      );
      const hostId = this.context.engine.selectIngressHost(
        input.hostId,
        prepared.submission.repoPath,
        origin,
        prepared.submission.originIdentity?.hostId,
      );
      if (!hostId || !this.context.engine.hostIngressAvailable(hostId))
        throw new ProtocolError(
          "invalid_input",
          `Selected submission host ${hostId ?? "(none)"} is offline or unavailable for ingress`,
        );
      const { verifyPublishedPlanning } = await import("../git/index");
      await verifyPublishedPlanning(prepared.submission);
      const validated = await validateSubmission(prepared.submission);
      assertSubmissionRouting(this.context.engine, prepared.submission);
      const needsRecipients =
        prepared.submission.notifyOriginOnCloseout ||
        prepared.submission.completionNotificationAgentIds.length > 0;
      if (needsRecipients)
        await validateCompletionRecipients(prepared.submission, (id) =>
          this.lookupCompletionRecipient(id, prepared.submission),
        );
      if (!this.context.store.existing(prepared.submission))
        this.context.store.validateDependencies(prepared.submission);
      if (
        prepared.submission.lanes.length ||
        prepared.submission.laneDocuments?.length
      )
        this.context.store.requireSubmissionLanes(
          prepared.submission,
          await repositoryOrigin(prepared.submission.repoPath),
        );
      await this.context.engine.hooks.previewPreDispatch(
        prepared.submission,
        validated.handoffText,
        validated.planningBase,
      );
      return { ...prepared, task: null, operation: null };
    }
    this.requireComplexityOnFirstAcceptance(
      prepared.submission,
      `submit:${prepared.submission.submissionId}`,
    );
    const acceptance = await this.context.engine.startSubmission(
      prepared.submission,
      true,
    );
    if ("backpressured" in acceptance) return acceptance;
    const operation = acceptance.operation;
    return {
      ...prepared,
      task:
        operation.state === "succeeded" && operation.result?.taskId
          ? this.context.store.task(operation.result.taskId)
          : null,
      operation,
    };
  }

  private async lookupCompletionRecipient(id: string, submission: Submission) {
    const identitySource =
      id === submission.originAgentId ? submission.originIdentity : undefined;
    const hostId = await this.context.engine.identifyOriginHost(
      id,
      identitySource,
    );
    if (!hostId)
      throw new Error(
        id === submission.originAgentId
          ? "Origin host is unknown or ambiguous"
          : `Completion recipient host is unknown or ambiguous: ${id}`,
      );
    return this.context.engine.withHost(hostId, () =>
      this.context.host.originAgent(id),
    );
  }
}
