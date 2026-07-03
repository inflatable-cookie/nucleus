import { invoke } from "@tauri-apps/api/core";
import {
  buildCommandHistoryQuery,
  buildDiagnosticsQuery,
  buildMemoryProposalsQuery,
  buildPlanningSessionsQuery,
  buildProviderReadIntentQuery,
  buildProviderReadinessOverviewQuery,
  buildResearchRunBriefsQuery,
  buildRuntimeReadinessQuery,
  buildTaskWorkProgressQuery,
  type ControlRequestEnvelopeDto,
  type ControlResponseEnvelopeDto,
} from "./envelopes";
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
