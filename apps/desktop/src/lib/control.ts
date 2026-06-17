import { invoke } from "@tauri-apps/api/core";

export const CONTROL_PROTOCOL_FAMILY = "nucleus.control";
export const CONTROL_PROTOCOL_VERSION = 1;
export const CONTROL_CLIENT_ID = "client:desktop";

export type RuntimeMetadataAction =
  | "list_artifact_metadata"
  | "list_command_evidence"
  | "get_local_runtime_readiness";
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

export async function queryCommandHistory(): Promise<CommandHistoryQueryResult> {
  const response = await submitControlEnvelope(buildCommandHistoryQuery());
  return commandHistoryFromResponse(response);
}

export async function queryRuntimeReadiness(): Promise<RuntimeReadinessQueryResult> {
  const response = await submitControlEnvelope(buildRuntimeReadinessQuery());
  return runtimeReadinessFromResponse(response);
}
