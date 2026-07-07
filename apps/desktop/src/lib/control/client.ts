import { invoke } from "@tauri-apps/api/core";
import {
  buildCommandHistoryQuery,
  buildDiagnosticsQuery,
  buildMemoryProposalsQuery,
  buildPlanningSessionsQuery,
  buildProductWorkflowSummaryQuery,
  buildProviderReadIntentQuery,
  buildProviderReadinessOverviewQuery,
  buildResearchRunBriefsQuery,
  buildRuntimeReadinessQuery,
  buildTaskWorkProgressQuery,
  type ControlRequestEnvelopeDto,
  type ControlResponseEnvelopeDto,
} from "./envelopes";
import {
  buildSelectedTaskActionReadinessQuery,
  buildSelectedTaskCommandAdmissionQuery,
  buildSelectedTaskOperatorActionGateQuery,
  buildSelectedTaskReviewDecisionAdmissionQuery,
  buildSelectedTaskReviewDecisionApplyQuery,
  buildSelectedTaskReviewNextQuery,
  buildSelectedTaskScmHandoffQuery,
  buildTaskWorkflowDrilldownQuery,
} from "./taskCommandEnvelopes";
import {
  commandHistoryFromResponse,
  diagnosticsFromResponse,
  providerReadIntentFromResponse,
  providerReadinessOverviewFromResponse,
  runtimeReadinessFromResponse,
  taskWorkProgressFromResponse,
  type CommandHistoryQueryResult,
  type DiagnosticsQueryResult,
  type ProviderReadinessOverviewQueryResult,
  type ProviderReadIntentQueryResult,
  type RuntimeReadinessQueryResult,
  type TaskWorkProgressQueryResult,
} from "./responses";
import {
  productWorkflowSummaryFromResponse,
  type ProductWorkflowSummaryQueryResult,
} from "./productWorkflow";
import {
  selectedTaskActionReadinessFromResponse,
  selectedTaskCommandAdmissionFromResponse,
  selectedTaskOperatorActionGateFromResponse,
  taskWorkflowDrilldownFromResponse,
  type SelectedTaskActionReadinessQueryResult,
  type SelectedTaskCommandAdmissionQueryResult,
  type SelectedTaskOperatorActionGateQueryResult,
  type TaskWorkflowDrilldownQueryResult,
} from "./taskWorkflow";
import {
  selectedTaskReviewNextFromResponse,
  type SelectedTaskReviewNextQueryResult,
} from "./selectedTaskReviewNext";
import {
  selectedTaskReviewDecisionAdmissionFromResponse,
  selectedTaskReviewDecisionApplyFromResponse,
  type SelectedTaskReviewDecisionAction,
  type SelectedTaskReviewDecisionAdmissionQueryResult,
  type SelectedTaskReviewDecisionApplyQueryResult,
} from "./selectedTaskReviewDecision";
import {
  selectedTaskScmHandoffFromResponse,
  type SelectedTaskScmHandoffQueryResult,
} from "./selectedTaskScmHandoff";
import {
  memoryProposalsFromResponse,
  planningSessionsFromResponse,
  researchRunBriefsFromResponse,
  type MemoryProposalsQueryResult,
  type PlanningSessionsQueryResult,
  type ResearchRunBriefsQueryResult,
} from "./planningResearch";
import type { DiagnosticsDomain } from "./types";

export async function submitControlEnvelope(
  request: ControlRequestEnvelopeDto,
): Promise<ControlResponseEnvelopeDto> {
  return invoke<ControlResponseEnvelopeDto>("submit_control_envelope", { request });
}

export async function queryCommandHistory(): Promise<CommandHistoryQueryResult> {
  const response = await submitControlEnvelope(buildCommandHistoryQuery());
  return commandHistoryFromResponse(response);
}

export async function queryRuntimeReadiness(): Promise<RuntimeReadinessQueryResult> {
  const response = await submitControlEnvelope(buildRuntimeReadinessQuery());
  return runtimeReadinessFromResponse(response);
}

export async function queryTaskWorkProgress(): Promise<TaskWorkProgressQueryResult> {
  const response = await submitControlEnvelope(buildTaskWorkProgressQuery());
  return taskWorkProgressFromResponse(response);
}

export async function queryDiagnostics(
  domain: DiagnosticsDomain = "all",
): Promise<DiagnosticsQueryResult> {
  const response = await submitControlEnvelope(buildDiagnosticsQuery(domain));
  return diagnosticsFromResponse(response);
}

export async function queryProviderReadinessOverview(): Promise<ProviderReadinessOverviewQueryResult> {
  const response = await submitControlEnvelope(buildProviderReadinessOverviewQuery());
  return providerReadinessOverviewFromResponse(response);
}

export async function queryProviderReadIntent(): Promise<ProviderReadIntentQueryResult> {
  const response = await submitControlEnvelope(buildProviderReadIntentQuery());
  return providerReadIntentFromResponse(response);
}

export async function queryPlanningSessions(
  projectId: string,
): Promise<PlanningSessionsQueryResult> {
  const response = await submitControlEnvelope(buildPlanningSessionsQuery(projectId));
  return planningSessionsFromResponse(response);
}

export async function queryMemoryProposals(
  projectId: string,
): Promise<MemoryProposalsQueryResult> {
  const response = await submitControlEnvelope(buildMemoryProposalsQuery(projectId));
  return memoryProposalsFromResponse(response);
}

export async function queryResearchRunBriefs(
  projectId: string,
): Promise<ResearchRunBriefsQueryResult> {
  const response = await submitControlEnvelope(buildResearchRunBriefsQuery(projectId));
  return researchRunBriefsFromResponse(response);
}

export async function queryProductWorkflowSummary(
  projectId: string,
): Promise<ProductWorkflowSummaryQueryResult> {
  const response = await submitControlEnvelope(buildProductWorkflowSummaryQuery(projectId));
  return productWorkflowSummaryFromResponse(response);
}

export async function queryTaskWorkflowDrilldown(
  projectId: string,
  taskId: string,
): Promise<TaskWorkflowDrilldownQueryResult> {
  const response = await submitControlEnvelope(
    buildTaskWorkflowDrilldownQuery(projectId, taskId),
  );
  return taskWorkflowDrilldownFromResponse(response);
}

export async function querySelectedTaskActionReadiness(
  projectId: string,
  taskId: string,
): Promise<SelectedTaskActionReadinessQueryResult> {
  const response = await submitControlEnvelope(
    buildSelectedTaskActionReadinessQuery(projectId, taskId),
  );
  return selectedTaskActionReadinessFromResponse(response);
}

export async function querySelectedTaskOperatorActionGate(
  projectId: string,
  taskId: string,
): Promise<SelectedTaskOperatorActionGateQueryResult> {
  const response = await submitControlEnvelope(
    buildSelectedTaskOperatorActionGateQuery(projectId, taskId),
  );
  return selectedTaskOperatorActionGateFromResponse(response);
}

export async function querySelectedTaskReviewNext(
  projectId: string,
  taskId: string,
): Promise<SelectedTaskReviewNextQueryResult> {
  const response = await submitControlEnvelope(
    buildSelectedTaskReviewNextQuery(projectId, taskId),
  );
  return selectedTaskReviewNextFromResponse(response);
}

export async function querySelectedTaskScmHandoff(
  projectId: string,
  taskId: string,
): Promise<SelectedTaskScmHandoffQueryResult> {
  const response = await submitControlEnvelope(
    buildSelectedTaskScmHandoffQuery(projectId, taskId),
  );
  return selectedTaskScmHandoffFromResponse(response);
}

export async function querySelectedTaskCommandAdmission(
  projectId: string,
  taskId: string,
  family: string,
  expectedRevision: string | null,
  reason: string | null,
): Promise<SelectedTaskCommandAdmissionQueryResult> {
  const response = await submitControlEnvelope(
    buildSelectedTaskCommandAdmissionQuery(
      projectId,
      taskId,
      family,
      expectedRevision,
      reason,
    ),
  );
  return selectedTaskCommandAdmissionFromResponse(response);
}

export async function querySelectedTaskReviewDecisionAdmission(
  projectId: string,
  taskId: string,
  action: SelectedTaskReviewDecisionAction,
  expectedRevision: string | null,
  reason: string | null,
  reviewedEvidenceRefs: string[],
  idempotencyKey: string,
): Promise<SelectedTaskReviewDecisionAdmissionQueryResult> {
  const response = await submitControlEnvelope(
    buildSelectedTaskReviewDecisionAdmissionQuery(
      projectId,
      taskId,
      action,
      expectedRevision,
      reason,
      reviewedEvidenceRefs,
      idempotencyKey,
    ),
  );
  return selectedTaskReviewDecisionAdmissionFromResponse(response);
}

export async function querySelectedTaskReviewDecisionApply(
  projectId: string,
  taskId: string,
  action: SelectedTaskReviewDecisionAction,
  expectedRevision: string | null,
  reason: string | null,
  reviewedEvidenceRefs: string[],
  idempotencyKey: string,
): Promise<SelectedTaskReviewDecisionApplyQueryResult> {
  const response = await submitControlEnvelope(
    buildSelectedTaskReviewDecisionApplyQuery(
      projectId,
      taskId,
      action,
      expectedRevision,
      reason,
      reviewedEvidenceRefs,
      idempotencyKey,
    ),
  );
  return selectedTaskReviewDecisionApplyFromResponse(response);
}
