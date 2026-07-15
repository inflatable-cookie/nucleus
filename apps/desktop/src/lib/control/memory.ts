import type { ControlResponseEnvelopeDto } from "./envelopes";
import type { CountByLabelDto } from "./planningResearch";

export type ControlAcceptedMemorySummaryDto = {
  memory_id: string;
  source_proposal_id: string | null;
  scope: string;
  kind: string;
  status: string;
  sensitivity: string;
  retention: string;
  confidence: string;
  created_by_ref: string;
  accepted_by_ref: string;
  reviewer_ref: string;
  source_ref_count: number;
  link_ref_count: number;
  evidence_ref_count: number;
  supersedes_count: number;
  superseded_by_count: number;
};

export type ControlAcceptedMemorySourceCountsDto = {
  accepted_records: number;
  out_of_scope_accepted_records: number;
  skipped_records: number;
  skipped_proposal_records: number;
  skipped_unsupported_records: number;
  skipped_decode_errors: number;
  source_refs: number;
  link_refs: number;
  evidence_refs: number;
  supersession_refs: number;
};

export type AcceptedMemoryQueryResult =
  | {
      state: "records";
      project_id: string;
      memories: ControlAcceptedMemorySummaryDto[];
      status_counts: CountByLabelDto[];
      scope_counts: CountByLabelDto[];
      kind_counts: CountByLabelDto[];
      sensitivity_counts: CountByLabelDto[];
      retention_counts: CountByLabelDto[];
      confidence_counts: CountByLabelDto[];
      source_counts: ControlAcceptedMemorySourceCountsDto;
      client_can_mutate: boolean;
      projection_written: boolean;
      embedding_available: boolean;
      provider_sync_available: boolean;
    }
  | { state: "empty" }
  | { state: "unsupported"; reason: string }
  | { state: "error"; kind: string; reason: string }
  | { state: "unexpected"; reason: string };

export function acceptedMemoryFromResponse(
  response: ControlResponseEnvelopeDto,
): AcceptedMemoryQueryResult {
  switch (response.body.type) {
    case "accepted_memory":
      return {
        state: "records",
        project_id: response.body.project_id,
        memories: response.body.memories,
        status_counts: response.body.status_counts,
        scope_counts: response.body.scope_counts,
        kind_counts: response.body.kind_counts,
        sensitivity_counts: response.body.sensitivity_counts,
        retention_counts: response.body.retention_counts,
        confidence_counts: response.body.confidence_counts,
        source_counts: response.body.source_counts,
        client_can_mutate: response.body.client_can_mutate,
        projection_written: response.body.projection_written,
        embedding_available: response.body.embedding_available,
        provider_sync_available: response.body.provider_sync_available,
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
        reason: `unexpected accepted memory response: ${response.body.type}`,
      };
  }
}
