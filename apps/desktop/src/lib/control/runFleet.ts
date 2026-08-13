import type { ControlOrchestrationRunStateCountDto } from "../control/generated/ControlOrchestrationRunStateCountDto";
import type { ControlOrchestrationRunSummaryDto } from "../control/generated/ControlOrchestrationRunSummaryDto";
import type { ControlOrchestrationRunReviewDto } from "../control/generated/ControlOrchestrationRunReviewDto";
import type { ControlOrchestrationRunReviewPatchDto } from "../control/generated/ControlOrchestrationRunReviewPatchDto";
import type { ControlResponseEnvelopeDto } from "./envelopes";
import { buildControlCommandEnvelope, buildControlQueryEnvelope } from "./envelopes";
import { submitControlEnvelope } from "./client";

export type OrchestrationRunsQueryResult =
  | {
      state: "record";
      project_id: string;
      runs: ControlOrchestrationRunSummaryDto[];
      state_counts: ControlOrchestrationRunStateCountDto[];
    }
  | { state: "empty" }
  | { state: "unsupported"; reason: string }
  | { state: "error"; kind: string; reason: string }
  | { state: "unexpected"; reason: string };

export type OrchestrationRunReviewQueryResult =
  | { state: "record"; review: ControlOrchestrationRunReviewDto }
  | { state: "empty" }
  | { state: "unsupported"; reason: string }
  | { state: "error"; kind: string; reason: string }
  | { state: "unexpected"; reason: string };

export type OrchestrationRunReviewPatchQueryResult =
  | { state: "record"; patch: ControlOrchestrationRunReviewPatchDto }
  | { state: "empty" }
  | { state: "unsupported"; reason: string }
  | { state: "error"; kind: string; reason: string }
  | { state: "unexpected"; reason: string };

export type RunTransitionResult =
  | { state: "accepted" }
  | { state: "rejected"; kind: string; reason: string }
  | { state: "unexpected"; reason: string };

export async function queryOrchestrationRuns(
  projectId: string,
): Promise<OrchestrationRunsQueryResult> {
  const response = await submitControlEnvelope(
    buildControlQueryEnvelope({
      kind: "orchestration_runs",
      query_id: "",
      action: "fleet",
      project_id: projectId,
      run_id: null,
      file_ref: null,
    }),
  );
  return orchestrationRunsFromResponse(response);
}

export async function queryOrchestrationRunReview(
  projectId: string,
  runId: string,
): Promise<OrchestrationRunReviewQueryResult> {
  const response = await submitControlEnvelope(
    buildControlQueryEnvelope({
      kind: "orchestration_runs",
      query_id: "",
      action: "review",
      project_id: projectId,
      run_id: runId,
      file_ref: null,
    }),
  );
  return orchestrationRunReviewFromResponse(response);
}

export async function queryOrchestrationRunReviewPatch(
  projectId: string,
  runId: string,
  fileRef: string,
): Promise<OrchestrationRunReviewPatchQueryResult> {
  const response = await submitControlEnvelope(
    buildControlQueryEnvelope({
      kind: "orchestration_runs",
      query_id: "",
      action: "review_patch",
      project_id: projectId,
      run_id: runId,
      file_ref: fileRef,
    }),
  );
  return orchestrationRunReviewPatchFromResponse(response);
}

/** Submit an operator accept/reject disposition for a delivered run. */
export async function submitRunTransition(
  runId: string,
  action: "accept" | "reject",
  expectedRevision: string | null,
  reason: string | null,
): Promise<RunTransitionResult> {
  const response = await submitControlEnvelope(
    buildControlCommandEnvelope({
      kind: "run_transition",
      command_id: `command:run:${action}:${runId}:${Date.now()}`,
      run_id: runId,
      action,
      expected_revision: expectedRevision,
      reason,
    }),
  );
  if (response.body.type !== "command_receipt") {
    if (response.body.type === "error") {
      return { state: "rejected", kind: response.body.kind, reason: response.body.reason };
    }
    return { state: "unexpected", reason: `unexpected run transition response: ${response.body.type}` };
  }
  if (response.body.status === "accepted_for_state_mutation") {
    return { state: "accepted" };
  }
  return {
    state: "rejected",
    kind: response.body.error_kind ?? "command_rejected",
    reason: response.body.error_reason ?? response.body.status,
  };
}

export function orchestrationRunsFromResponse(
  response: ControlResponseEnvelopeDto,
): OrchestrationRunsQueryResult {
  switch (response.body.type) {
    case "orchestration_runs":
      return {
        state: "record",
        project_id: response.body.project_id,
        runs: response.body.runs,
        state_counts: response.body.state_counts,
      };
    case "query_empty":
      return { state: "empty" };
    case "query_unsupported":
      return { state: "unsupported", reason: response.body.reason };
    case "error":
      return { state: "error", kind: response.body.kind, reason: response.body.reason };
    default:
      return {
        state: "unexpected",
        reason: `unexpected orchestration runs response: ${response.body.type}`,
      };
  }
}

export function orchestrationRunReviewFromResponse(
  response: ControlResponseEnvelopeDto,
): OrchestrationRunReviewQueryResult {
  switch (response.body.type) {
    case "orchestration_run_review":
      return { state: "record", review: response.body.review };
    case "query_empty":
      return { state: "empty" };
    case "query_unsupported":
      return { state: "unsupported", reason: response.body.reason };
    case "error":
      return { state: "error", kind: response.body.kind, reason: response.body.reason };
    default:
      return {
        state: "unexpected",
        reason: `unexpected orchestration run review response: ${response.body.type}`,
      };
  }
}

export function orchestrationRunReviewPatchFromResponse(
  response: ControlResponseEnvelopeDto,
): OrchestrationRunReviewPatchQueryResult {
  switch (response.body.type) {
    case "orchestration_run_review_patch":
      return { state: "record", patch: response.body.patch };
    case "query_empty":
      return { state: "empty" };
    case "query_unsupported":
      return { state: "unsupported", reason: response.body.reason };
    case "error":
      return { state: "error", kind: response.body.kind, reason: response.body.reason };
    default:
      return {
        state: "unexpected",
        reason: `unexpected orchestration run review patch response: ${response.body.type}`,
      };
  }
}
