import { invoke } from "@tauri-apps/api/core";

export const CONTROL_PROTOCOL_FAMILY = "nucleus.control";
export const CONTROL_PROTOCOL_VERSION = 1;
export const CONTROL_CLIENT_ID = "client:desktop";

export type RuntimeMetadataAction =
  | "list_artifact_metadata"
  | "list_command_evidence"
  | "get_local_runtime_readiness";
export type DiagnosticsDomain = "steward" | "effigy" | "management_sync" | "scm_session" | "all";
export type ControlStateDomain = "projects" | "tasks" | "workspaces";
export type ControlTaskTransitionAction = "start" | "block" | "complete" | "archive";

export type ControlProjectRecordDto = {
  project_id: string;
  display_name: string;
  status: string;
  importance_level: string;
  revision_id: string;
};

export type ControlTaskRecordDto = {
  task_id: string;
  project_id: string;
  title: string;
  description: string | null;
  importance: string;
  action_type: string;
  activity: string;
  assignment_intent: string | null;
  agent_ready: boolean;
  revision_id: string;
};

export type ControlCommandEvidenceRecordDto = {
  evidence_id: string;
  command_request_id: string;
  status: string;
  exit_status: number | null;
  retention: string;
  summary: string | null;
  stdout_artifact_ref: string | null;
  stderr_artifact_ref: string | null;
};

export type ControlRuntimeReadinessBlockerDto = {
  source: string;
  code: string;
  message: string;
};

export type ControlRuntimeReadinessDiagnosticDto = {
  host_id: string;
  runtime_surface: string;
  status: string;
  blockers: ControlRuntimeReadinessBlockerDto[];
  evidence_refs: string[];
  repair_hints: string[];
  summary: string | null;
};

export type StewardProposalDiagnosticDto = {
  proposal_id: string;
  kind: string;
  review: string;
  requires_human_approval: boolean;
  evidence_refs: string[];
  receipt_refs: string[];
  summary: string | null;
};

export type StewardCommandAdmissionDiagnosticDto = {
  command_id: string;
  status: string;
  terminal: boolean;
};

export type StewardCommandOutcomeDiagnosticDto = {
  command_id: string;
  status: string;
  terminal: boolean;
  proposal_refs: string[];
  sync_assistance_refs: string[];
};

export type StewardDiagnosticsDto = {
  proposals: StewardProposalDiagnosticDto[];
  command_admissions: StewardCommandAdmissionDiagnosticDto[];
  command_outcomes: StewardCommandOutcomeDiagnosticDto[];
  client_can_mutate: false;
};

export type EffigyDiagnosticsDto = {
  integration_status: string;
  selector_refs: string[];
  health_status: string | null;
  validation_status: string | null;
  evidence_refs: string[];
  client_can_run_effigy: false;
};

export type SyncPlanDiagnosticDto = {
  plan_id: string;
  kind: string;
  status: string;
  file_refs: string[];
  receipt_ids: string[];
};

export type SyncRepairDiagnosticDto = {
  proposal_id: string;
  kind: string;
  review: string;
  file_ref: string;
  preserves_incoming_record: boolean;
};

export type SyncAssistanceDiagnosticDto = {
  conflict_id: string;
  kind: string;
  review: string;
  requires_human_approval: boolean;
};

export type SyncCapturePrepDiagnosticDto = {
  prep_id: string;
  plan_id: string;
  status: string;
  file_refs: string[];
  receipt_ids: string[];
  execution_available: boolean;
};

export type SyncDiagnosticsDto = {
  plans: SyncPlanDiagnosticDto[];
  repairs: SyncRepairDiagnosticDto[];
  assistance_routes: SyncAssistanceDiagnosticDto[];
  capture_preps: SyncCapturePrepDiagnosticDto[];
  client_can_mutate_provider: false;
};

export type ScmSessionPlanDiagnosticDto = {
  session_id: string;
  repository_id: string;
  provider_kind: string;
  mode: string;
  status: string;
  user_can_test_in_known_directory: boolean;
  runtime_constraints: string[];
};

export type ScmCommandAdmissionDiagnosticDto = {
  command_id: string;
  status: string;
  required_capability: string;
  executes_provider_command: boolean;
};

export type ScmWorkItemLinkDiagnosticDto = {
  link_id: string;
  task_id: string;
  work_item_id: string;
  work_session_id: string;
  session_command_ids: string[];
  change_refs: string[];
  checkpoint_ids: string[];
  diff_summary_ids: string[];
  requires_repair: boolean;
};

export type ScmSessionDiagnosticsDto = {
  sessions: ScmSessionPlanDiagnosticDto[];
  admissions: ScmCommandAdmissionDiagnosticDto[];
  work_item_links: ScmWorkItemLinkDiagnosticDto[];
  client_can_mutate_working_copy: false;
};

export type ControlDiagnosticsSnapshotDto = {
  steward: StewardDiagnosticsDto;
  effigy: EffigyDiagnosticsDto;
  management_sync: SyncDiagnosticsDto;
  scm_session: ScmSessionDiagnosticsDto;
};

export type ControlDiagnosticsResultDto =
  | { domain: "steward"; record: StewardDiagnosticsDto }
  | { domain: "effigy"; record: EffigyDiagnosticsDto }
  | { domain: "management_sync"; record: SyncDiagnosticsDto }
  | { domain: "scm_session"; record: ScmSessionDiagnosticsDto }
  | { domain: "all"; record: ControlDiagnosticsSnapshotDto };

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
        type: "diagnostics";
        result: ControlDiagnosticsResultDto;
      }
    | { type: "state_records"; domain: string; records: unknown[] }
    | { type: "command_receipt"; command_id: string; status: string }
    | { type: "error"; kind: string; reason: string };
};

export type CommandHistoryQueryResult =
  | {
      state: "records";
      records: ControlCommandEvidenceRecordDto[];
    }
  | {
      state: "empty";
    }
  | {
      state: "unsupported";
      reason: string;
    }
  | {
      state: "error";
      kind: string;
      reason: string;
    }
  | {
      state: "unexpected";
      reason: string;
    };

export type RuntimeReadinessQueryResult =
  | {
      state: "records";
      records: ControlRuntimeReadinessDiagnosticDto[];
    }
  | {
      state: "empty";
    }
  | {
      state: "unsupported";
      reason: string;
    }
  | {
      state: "error";
      kind: string;
      reason: string;
    }
  | {
      state: "unexpected";
      reason: string;
    };

export type DiagnosticsQueryResult =
  | {
      state: "records";
      result: ControlDiagnosticsResultDto;
    }
  | {
      state: "empty";
    }
  | {
      state: "unsupported";
      reason: string;
    }
  | {
      state: "error";
      kind: string;
      reason: string;
    }
  | {
      state: "unexpected";
      reason: string;
    };

function buildControlQueryEnvelope(query: ControlQueryDto): ControlRequestEnvelopeDto {
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

function buildControlCommandEnvelope(command: ControlCommandDto): ControlRequestEnvelopeDto {
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

export function buildTaskTransitionCommand(
  task: ControlTaskRecordDto,
  action: ControlTaskTransitionAction,
  reason: string | null = null,
): ControlRequestEnvelopeDto {
  return buildControlCommandEnvelope({
    kind: "task",
    command_id: "",
    action,
    task_id: task.task_id,
    expected_revision: task.revision_id,
    reason,
  });
}

export function buildStartTaskCommand(task: ControlTaskRecordDto): ControlRequestEnvelopeDto {
  return buildTaskTransitionCommand(task, "start");
}

export function buildBlockTaskCommand(
  task: ControlTaskRecordDto,
  reason: string,
): ControlRequestEnvelopeDto {
  return buildTaskTransitionCommand(task, "block", reason);
}

export function buildCompleteTaskCommand(task: ControlTaskRecordDto): ControlRequestEnvelopeDto {
  return buildTaskTransitionCommand(task, "complete");
}

export function buildArchiveTaskCommand(task: ControlTaskRecordDto): ControlRequestEnvelopeDto {
  return buildTaskTransitionCommand(task, "archive");
}

export async function submitControlEnvelope(
  request: ControlRequestEnvelopeDto,
): Promise<ControlResponseEnvelopeDto> {
  return invoke<ControlResponseEnvelopeDto>("submit_control_envelope", { request });
}

export function projectRecordsFromResponse(
  response: ControlResponseEnvelopeDto,
): ControlProjectRecordDto[] {
  return response.body.type === "project_records" ? response.body.records : [];
}

export function taskRecordsFromResponse(
  response: ControlResponseEnvelopeDto,
): ControlTaskRecordDto[] {
  return response.body.type === "task_records" ? response.body.records : [];
}

export function commandHistoryFromResponse(
  response: ControlResponseEnvelopeDto,
): CommandHistoryQueryResult {
  switch (response.body.type) {
    case "command_evidence_records":
      return {
        state: "records",
        records: response.body.records,
      };
    case "query_empty":
      return { state: "empty" };
    case "query_unsupported":
      return {
        state: "unsupported",
        reason: response.body.reason,
      };
    case "error":
      return {
        state: "error",
        kind: response.body.kind,
        reason: response.body.reason,
      };
    default:
      return {
        state: "unexpected",
        reason: `unexpected command history response: ${response.body.type}`,
      };
  }
}

export function runtimeReadinessFromResponse(
  response: ControlResponseEnvelopeDto,
): RuntimeReadinessQueryResult {
  switch (response.body.type) {
    case "runtime_readiness_diagnostics":
      return {
        state: "records",
        records: response.body.records,
      };
    case "query_empty":
      return { state: "empty" };
    case "query_unsupported":
      return {
        state: "unsupported",
        reason: response.body.reason,
      };
    case "error":
      return {
        state: "error",
        kind: response.body.kind,
        reason: response.body.reason,
      };
    default:
      return {
        state: "unexpected",
        reason: `unexpected runtime readiness response: ${response.body.type}`,
      };
  }
}

export function diagnosticsFromResponse(response: ControlResponseEnvelopeDto): DiagnosticsQueryResult {
  switch (response.body.type) {
    case "diagnostics":
      return {
        state: "records",
        result: response.body.result,
      };
    case "query_empty":
      return { state: "empty" };
    case "query_unsupported":
      return {
        state: "unsupported",
        reason: response.body.reason,
      };
    case "error":
      return {
        state: "error",
        kind: response.body.kind,
        reason: response.body.reason,
      };
    default:
      return {
        state: "unexpected",
        reason: `unexpected diagnostics response: ${response.body.type}`,
      };
  }
}

export async function queryCommandHistory(): Promise<CommandHistoryQueryResult> {
  const response = await submitControlEnvelope(buildCommandHistoryQuery());
  return commandHistoryFromResponse(response);
}

export async function queryRuntimeReadiness(): Promise<RuntimeReadinessQueryResult> {
  const response = await submitControlEnvelope(buildRuntimeReadinessQuery());
  return runtimeReadinessFromResponse(response);
}

export async function queryDiagnostics(
  domain: DiagnosticsDomain = "all",
): Promise<DiagnosticsQueryResult> {
  const response = await submitControlEnvelope(buildDiagnosticsQuery(domain));
  return diagnosticsFromResponse(response);
}
