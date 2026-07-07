import {
  CONTROL_CLIENT_ID,
  CONTROL_PROTOCOL_FAMILY,
  CONTROL_PROTOCOL_VERSION,
  type ControlCommandEvidenceRecordDto,
  type ControlDiagnosticsResultDto,
  type ControlProviderReadIntentQueryResultDto,
  type ControlProviderReadinessOverviewDto,
  type ControlProjectRecordDto,
  type ControlRuntimeReadinessDiagnosticDto,
  type ControlStateDomain,
  type TaskAgentWorkUnitDiagnosticDto,
  type ControlTaskRecordDto,
  type ControlTaskTransitionAction,
  type DiagnosticsDomain,
  type ProviderReadIntentAction,
  type ProviderReadinessOverviewAction,
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
import type { ControlProductWorkflowSummaryDto } from "./productWorkflow";
import type {
  ControlSelectedTaskCommandAdmissionDto,
  ControlSelectedTaskActionReadinessDto,
  ControlSelectedTaskOperatorActionGateDto,
  ControlTaskWorkflowDrilldownDto,
} from "./taskWorkflow";

export type ControlQueryDto =
  | {
      kind: "runtime_metadata";
      query_id: string;
      action: RuntimeMetadataAction;
    }
  | {
      kind: "state";
      query_id: string;
      domain: ControlStateDomain;
      scope: { type: "list" };
    }
  | {
      kind: "diagnostics";
      query_id: string;
      domain: DiagnosticsDomain;
    }
  | {
      kind: "provider_read_intent";
      query_id: string;
      action: ProviderReadIntentAction;
    }
  | {
      kind: "provider_readiness_overview";
      query_id: string;
      action: ProviderReadinessOverviewAction;
    }
  | {
      kind: "planning_sessions" | "memory_proposals" | "research_run_briefs";
      query_id: string;
      action: "sessions" | "proposals" | "runs";
      project_id: string;
    }
  | {
      kind: "product_workflow_summary";
      query_id: string;
      action: "summary";
      project_id: string;
    }
  | {
      kind: "task_workflow_drilldown";
      query_id: string;
      action: "drilldown";
      project_id: string;
      task_id: string;
    }
  | {
      kind: "selected_task_action_readiness";
      query_id: string;
      action: "readiness";
      project_id: string;
      task_id: string;
    }
  | {
      kind: "selected_task_operator_action_gate";
      query_id: string;
      action: "gate";
      project_id: string;
      task_id: string;
    }
  | {
      kind: "selected_task_command_admission";
      query_id: string;
      action: "dry_run";
      project_id: string;
      task_id: string;
      family: string;
      expected_revision: string | null;
      reason: string | null;
      operator_ref: string;
    };

export type ControlCommandDto = {
  kind: "task";
  command_id: string;
  action: ControlTaskTransitionAction;
  task_id: string;
  expected_revision: string | null;
  reason: string | null;
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

export type ControlResponseEnvelopeDto = {
  protocol_family: string;
  protocol_version: number;
  request_id: string;
  status: "accepted" | "complete" | "rejected" | "partial";
  body:
    | { type: "query_empty" }
    | { type: "query_unsupported"; reason: string }
    | {
        type: "project_records";
        records: ControlProjectRecordDto[];
      }
    | {
        type: "task_records";
        records: ControlTaskRecordDto[];
      }
    | {
        type: "command_evidence_records";
        records: ControlCommandEvidenceRecordDto[];
      }
    | {
        type: "runtime_readiness_diagnostics";
        records: ControlRuntimeReadinessDiagnosticDto[];
      }
    | {
        type: "task_work_progress_records";
        records: TaskAgentWorkUnitDiagnosticDto[];
        client_can_mutate: false;
        provider_execution_available: false;
      }
    | {
        type: "diagnostics";
        result: ControlDiagnosticsResultDto;
      }
    | {
        type: "provider_read_intent";
        result: ControlProviderReadIntentQueryResultDto;
      }
    | {
        type: "provider_readiness_overview";
        overview: ControlProviderReadinessOverviewDto;
      }
    | {
        type: "planning_sessions";
        project_id: string;
        sessions: ControlPlanningSessionSummaryDto[];
        status_counts: CountByLabelDto[];
        source_counts: ControlPlanningSessionSourceCountsDto;
        client_can_mutate: false;
        provider_execution_available: false;
      }
    | {
        type: "memory_proposals";
        project_id: string;
        proposals: ControlMemoryProposalSummaryDto[];
        status_counts: CountByLabelDto[];
        scope_counts: CountByLabelDto[];
        sensitivity_counts: CountByLabelDto[];
        retention_counts: CountByLabelDto[];
        source_counts: ControlMemoryProposalSourceCountsDto;
        client_can_mutate: false;
        provider_execution_available: false;
      }
    | {
        type: "research_run_briefs";
        project_id: string;
        runs: ControlResearchRunBriefSummaryDto[];
        status_counts: CountByLabelDto[];
        source_kind_counts: CountByLabelDto[];
        observation_kind_counts: CountByLabelDto[];
        synthesis_kind_counts: CountByLabelDto[];
        source_counts: ControlResearchRunBriefSourceCountsDto;
        client_can_mutate: false;
        provider_execution_available: false;
      }
    | {
        type: "product_workflow_summary";
        summary: ControlProductWorkflowSummaryDto;
      }
    | {
        type: "task_workflow_drilldown";
        drilldown: ControlTaskWorkflowDrilldownDto;
      }
    | {
        type: "selected_task_action_readiness";
        readiness: ControlSelectedTaskActionReadinessDto;
      }
    | {
        type: "selected_task_operator_action_gate";
        gate: ControlSelectedTaskOperatorActionGateDto;
      }
    | {
        type: "selected_task_command_admission";
        admission: ControlSelectedTaskCommandAdmissionDto;
      }
    | { type: "state_records"; domain: string; records: unknown[] }
    | { type: "command_receipt"; command_id: string; status: string }
    | { type: "error"; kind: string; reason: string };
};

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
