use nucleus_projects::ProjectId;

use crate::{
    AcceptedMemoryConfidence, AcceptedMemoryConfidenceCount, AcceptedMemoryKindCount,
    AcceptedMemoryProjection, AcceptedMemoryRetention, AcceptedMemoryRetentionCount,
    AcceptedMemoryScopeCount, AcceptedMemorySensitivity, AcceptedMemorySensitivityCount,
    AcceptedMemorySourceCounts, AcceptedMemoryStatusCount, AcceptedMemorySummary,
    AcceptedMemorySummaryKind, AcceptedMemorySummaryScope, AcceptedMemorySummaryStatus,
    ControlResponseBodyDto, ControlResponseEnvelopeDto, ServerControlRequestId,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerQueryResult,
};

#[test]
fn response_envelope_dto_serializes_accepted_memory_without_bodies_or_effects() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:accepted-memory".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::AcceptedMemory(
            AcceptedMemoryProjection {
                project_id: ProjectId("project:nucleus".to_owned()),
                memories: vec![AcceptedMemorySummary {
                    memory_id: "memory:nucleus:1".to_owned(),
                    source_proposal_id: Some("memory-proposal:nucleus:1".to_owned()),
                    scope: AcceptedMemorySummaryScope::Project,
                    kind: AcceptedMemorySummaryKind::Decision,
                    status: AcceptedMemorySummaryStatus::Accepted,
                    sensitivity: AcceptedMemorySensitivity::InternalProject,
                    retention: AcceptedMemoryRetention::ProjectContextCandidate,
                    confidence: AcceptedMemoryConfidence::High,
                    created_by_ref: "agent:steward".to_owned(),
                    accepted_by_ref: "operator:tom".to_owned(),
                    reviewer_ref: "operator:tom".to_owned(),
                    source_ref_count: 1,
                    link_ref_count: 2,
                    evidence_ref_count: 1,
                    supersedes_count: 1,
                    superseded_by_count: 0,
                }],
                status_counts: vec![AcceptedMemoryStatusCount {
                    status: AcceptedMemorySummaryStatus::Accepted,
                    count: 1,
                }],
                scope_counts: vec![AcceptedMemoryScopeCount {
                    scope: AcceptedMemorySummaryScope::Project,
                    count: 1,
                }],
                kind_counts: vec![AcceptedMemoryKindCount {
                    kind: AcceptedMemorySummaryKind::Decision,
                    count: 1,
                }],
                sensitivity_counts: vec![AcceptedMemorySensitivityCount {
                    sensitivity: AcceptedMemorySensitivity::InternalProject,
                    count: 1,
                }],
                retention_counts: vec![AcceptedMemoryRetentionCount {
                    retention: AcceptedMemoryRetention::ProjectContextCandidate,
                    count: 1,
                }],
                confidence_counts: vec![AcceptedMemoryConfidenceCount {
                    confidence: AcceptedMemoryConfidence::High,
                    count: 1,
                }],
                source_counts: AcceptedMemorySourceCounts {
                    accepted_records: 1,
                    out_of_scope_accepted_records: 0,
                    skipped_records: 2,
                    skipped_proposal_records: 1,
                    skipped_unsupported_records: 0,
                    skipped_decode_errors: 1,
                    source_refs: 1,
                    link_refs: 2,
                    evidence_refs: 1,
                    supersession_refs: 1,
                },
                client_can_mutate: false,
                projection_written: false,
                embedding_available: false,
                provider_sync_available: false,
            },
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::AcceptedMemory {
            project_id,
            memories,
            source_counts,
            client_can_mutate,
            projection_written,
            embedding_available,
            provider_sync_available,
            ..
        } if project_id == "project:nucleus"
            && memories.len() == 1
            && memories[0].memory_id == "memory:nucleus:1"
            && source_counts.accepted_records == 1
            && source_counts.skipped_records == 2
            && !client_can_mutate
            && !projection_written
            && !embedding_available
            && !provider_sync_available
    ));
    assert!(json.contains("\"type\":\"accepted_memory\""));
    assert!(!json.contains("Hidden accepted summary"));
    assert!(!json.contains("raw_transcript"));
    assert!(!json.contains("provider_payload"));
    assert!(!json.contains("private_memory_body"));
}
