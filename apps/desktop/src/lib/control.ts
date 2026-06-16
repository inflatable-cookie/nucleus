import { invoke } from "@tauri-apps/api/core";

export const CONTROL_PROTOCOL_FAMILY = "nucleus.control";
export const CONTROL_PROTOCOL_VERSION = 1;
export const CONTROL_CLIENT_ID = "client:desktop";

export type RuntimeMetadataAction = "list_artifact_metadata" | "list_command_evidence";
export type ControlStateDomain = "projects" | "tasks" | "workspaces";

export type ControlProjectRecordDto = {
  project_id: string;
  display_name: string;
  status: string;
  importance_level: string;
  revision_id: string;
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

export type ControlRequestEnvelopeDto = {
  protocol_family: typeof CONTROL_PROTOCOL_FAMILY;
  protocol_version: typeof CONTROL_PROTOCOL_VERSION;
  request_id: string;
  client_id: string;
  body: {
    type: "query";
    query: ControlQueryDto;
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
    | { type: "state_records"; domain: string; records: unknown[] }
    | { type: "command_receipt"; command_id: string; status: string }
    | { type: "error"; kind: string; reason: string };
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
