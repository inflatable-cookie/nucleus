import { invoke } from "@tauri-apps/api/core";

export type ControlRequestEnvelopeDto = {
  protocol_family: "nucleus.control";
  protocol_version: 1;
  request_id: string;
  client_id: string;
  body: {
    type: "query";
    query: {
      kind: "runtime_metadata";
      query_id: string;
      action: "list_artifact_metadata";
    };
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
    | { type: "state_records"; domain: string; records: unknown[] }
    | { type: "command_receipt"; command_id: string; status: string }
    | { type: "error"; kind: string; reason: string };
};

export function buildArtifactMetadataProbe(): ControlRequestEnvelopeDto {
  const suffix = crypto.randomUUID();

  return {
    protocol_family: "nucleus.control",
    protocol_version: 1,
    request_id: `request:desktop:${suffix}`,
    client_id: "client:desktop",
    body: {
      type: "query",
      query: {
        kind: "runtime_metadata",
        query_id: `query:desktop:${suffix}`,
        action: "list_artifact_metadata",
      },
    },
  };
}

export async function submitControlEnvelope(
  request: ControlRequestEnvelopeDto,
): Promise<ControlResponseEnvelopeDto> {
  return invoke<ControlResponseEnvelopeDto>("submit_control_envelope", { request });
}
