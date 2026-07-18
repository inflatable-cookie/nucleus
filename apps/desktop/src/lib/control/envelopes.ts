import {
  CONTROL_CLIENT_ID,
  CONTROL_PROTOCOL_FAMILY,
  CONTROL_PROTOCOL_VERSION,
  type ControlCommandEvidenceRecordDto,
  type ControlDiagnosticsResultDto,
  type ControlProviderReadIntentQueryResultDto,
  type ControlProviderReadinessOverviewDto,
  type ControlProjectRecordDto,
  type ControlGoalRecordDto,
  type ControlRuntimeReadinessDiagnosticDto,
  type ControlStateDomain,
  type TaskAgentWorkUnitDiagnosticDto,
  type ControlTaskRecordDto,
  type ControlTaskTransitionAction,
  type DiagnosticsDomain,
  type RuntimeMetadataAction,
} from "./types";
import type {
  ControlMemoryProposalSourceCountsDto,
  ControlMemoryProposalSummaryDto,
  ControlPlanningSessionSourceCountsDto,
  ControlPlanningSessionSummaryDto,
  ControlResearchRunBriefSourceCountsDto,
  ControlResearchRunBriefSummaryDto,
  CountByLabelDto,
} from "./planningResearch";
import type {
  ControlAcceptedMemorySourceCountsDto,
  ControlAcceptedMemorySummaryDto,
} from "./memory";
import type { ControlProductWorkflowSummaryDto } from "./productWorkflow";
import type {
  ControlSelectedTaskCommandAdmissionDto,
  ControlSelectedTaskActionReadinessDto,
  ControlSelectedTaskOperatorActionGateDto,
  ControlTaskWorkflowDrilldownDto,
} from "./taskWorkflow";
import type { ControlSelectedTaskReviewNextDto } from "./selectedTaskReviewNext";
import type { ControlSelectedTaskReviewOutcomeRouteDto } from "./selectedTaskReviewOutcomeRoute";
import type { ControlSelectedTaskRouteAdmissionDto } from "./selectedTaskRouteAdmission";
import type { ControlSelectedTaskCompletionRouteApplyDto } from "./selectedTaskCompletionRouteApply";
import type { ControlSelectedTaskProductAggregateDto } from "./selectedTaskProductAggregate";
import type { ControlSelectedTaskReworkPreparationDto } from "./selectedTaskReworkPreparation";
import type { ControlSelectedTaskReviewDecisionResponseBodyDto } from "./selectedTaskReviewDecisionEnvelope";
import type { ControlSelectedTaskScmHandoffDto } from "./selectedTaskScmHandoff";
import type { ControlQueryDto } from "./queryEnvelopeTypes";

export type { ControlQueryDto } from "./queryEnvelopeTypes";

export type ControlCommandDto =
  | {
      kind: "task";
      command_id: string;
      action: ControlTaskTransitionAction;
      task_id: string;
      expected_revision: string | null;
      reason: string | null;
    }
  | {
      kind: "project_create";
      command_id: string;
      display_name: string;
      actor_ref: string;
      authority_host_ref: string;
      idempotency_key: string;
    }
  | {
      kind: "project_lifecycle";
      command_id: string;
      project_id: string;
      action: "rename" | "park" | "archive" | "restore" | "delete";
      expected_revision: string;
      display_name: string | null;
      actor_ref: string;
      authority_host_ref: string;
      idempotency_key: string;
    }
  | {
      kind: "project_resource";
      command_id: string;
      project_id: string;
      action: "attach" | "update" | "repair" | "remove";
      expected_revision: string;
      resource_id: string | null;
      locator: string | null;
      display_name: string | null;
      role: "working" | "management" | "reference" | null;
      set_as_default: boolean | null;
      actor_ref: string;
      authority_host_ref: string;
      idempotency_key: string;
    };

export type ControlRequestEnvelopeDto = {
  protocol_family: typeof CONTROL_PROTOCOL_FAMILY;
  protocol_version: typeof CONTROL_PROTOCOL_VERSION;
  request_id: string;
  client_id: string;
  body:
    | {
        type: "query";
        query: ControlQueryDto;
      }
    | {
        type: "command";
        command: ControlCommandDto;
      };
};

// Canonical shape comes from the Rust DTOs via ts-rs.
export type { ControlResponseEnvelopeDto } from "./generated/ControlResponseEnvelopeDto";
import type { ControlResponseEnvelopeDto } from "./generated/ControlResponseEnvelopeDto";

export function buildControlQueryEnvelope(query: ControlQueryDto): ControlRequestEnvelopeDto {
  const suffix = crypto.randomUUID();

  return {
    protocol_family: CONTROL_PROTOCOL_FAMILY,
    protocol_version: CONTROL_PROTOCOL_VERSION,
    request_id: `request:desktop:${suffix}`,
    client_id: CONTROL_CLIENT_ID,
    body: {
      type: "query",
      query: {
        ...query,
        query_id: query.query_id || `query:desktop:${suffix}`,
      },
    },
  };
}

export function buildControlCommandEnvelope(command: ControlCommandDto): ControlRequestEnvelopeDto {
  const suffix = crypto.randomUUID();
  const commandId = command.command_id || `command:desktop:${suffix}`;

  return {
    protocol_family: CONTROL_PROTOCOL_FAMILY,
    protocol_version: CONTROL_PROTOCOL_VERSION,
    request_id: `request:desktop:${suffix}`,
    client_id: CONTROL_CLIENT_ID,
    body: {
      type: "command",
      command: {
        ...command,
        command_id: commandId,
      },
    },
  };
}

export function buildRuntimeMetadataQuery(
  action: RuntimeMetadataAction,
): ControlRequestEnvelopeDto {
  return buildControlQueryEnvelope({
    kind: "runtime_metadata",
    query_id: "",
    action,
  });
}

export function buildStateListQuery(domain: ControlStateDomain): ControlRequestEnvelopeDto {
  return buildControlQueryEnvelope({
    kind: "state",
    query_id: "",
    domain,
    scope: { type: "list" },
  });
}

export function buildArtifactMetadataProbe(): ControlRequestEnvelopeDto {
  return buildRuntimeMetadataQuery("list_artifact_metadata");
}

export function buildCommandHistoryQuery(): ControlRequestEnvelopeDto {
  return buildRuntimeMetadataQuery("list_command_evidence");
}

export function buildTaskWorkProgressQuery(): ControlRequestEnvelopeDto {
  return buildRuntimeMetadataQuery("list_task_work_progress");
}

export function buildRuntimeReadinessQuery(): ControlRequestEnvelopeDto {
  return buildRuntimeMetadataQuery("get_local_runtime_readiness");
}

export function buildDiagnosticsQuery(domain: DiagnosticsDomain = "all"): ControlRequestEnvelopeDto {
  return buildControlQueryEnvelope({
    kind: "diagnostics",
    query_id: "",
    domain,
  });
}

export function buildProviderReadinessOverviewQuery(): ControlRequestEnvelopeDto {
  return buildControlQueryEnvelope({
    kind: "provider_readiness_overview",
    query_id: "",
    action: "overview",
  });
}

export function buildProviderReadIntentQuery(): ControlRequestEnvelopeDto {
  return buildControlQueryEnvelope({
    kind: "provider_read_intent",
    query_id: "",
    action: "projection",
  });
}

export function buildPlanningSessionsQuery(projectId: string): ControlRequestEnvelopeDto {
  return buildControlQueryEnvelope({
    kind: "planning_sessions",
    query_id: "",
    action: "sessions",
    project_id: projectId,
  });
}

export function buildMemoryProposalsQuery(projectId: string): ControlRequestEnvelopeDto {
  return buildControlQueryEnvelope({
    kind: "memory_proposals",
    query_id: "",
    action: "proposals",
    project_id: projectId,
  });
}

export function buildAcceptedMemoryQuery(projectId: string): ControlRequestEnvelopeDto {
  return buildControlQueryEnvelope({
    kind: "accepted_memory",
    query_id: "",
    action: "memory",
    project_id: projectId,
  });
}

export function buildResearchRunBriefsQuery(projectId: string): ControlRequestEnvelopeDto {
  return buildControlQueryEnvelope({
    kind: "research_run_briefs",
    query_id: "",
    action: "runs",
    project_id: projectId,
  });
}

export function buildProductWorkflowSummaryQuery(projectId: string): ControlRequestEnvelopeDto {
  return buildControlQueryEnvelope({
    kind: "product_workflow_summary",
    query_id: "",
    action: "summary",
    project_id: projectId,
  });
}
