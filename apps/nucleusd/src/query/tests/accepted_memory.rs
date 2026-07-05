use nucleus_server::{
    ControlAcceptedMemoryConfidenceCountDto, ControlAcceptedMemoryKindCountDto,
    ControlAcceptedMemoryRetentionCountDto, ControlAcceptedMemoryScopeCountDto,
    ControlAcceptedMemorySensitivityCountDto, ControlAcceptedMemorySourceCountsDto,
    ControlAcceptedMemoryStatusCountDto, ControlAcceptedMemorySummaryDto,
};

use super::*;

#[test]
fn accepted_memory_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::accepted_memory_response_lines(
        "accepted-memory",
        "project:nucleus-local".to_owned(),
        vec![ControlAcceptedMemorySummaryDto {
            memory_id: "memory:nucleus-local:bootstrap".to_owned(),
            source_proposal_id: Some("memory-proposal:nucleus-local:bootstrap".to_owned()),
            scope: "project".to_owned(),
            kind: "decision".to_owned(),
            status: "accepted".to_owned(),
            sensitivity: "internal_project".to_owned(),
            retention: "project_context_candidate".to_owned(),
            confidence: "high".to_owned(),
            created_by_ref: "agent:steward".to_owned(),
            accepted_by_ref: "operator:tom".to_owned(),
            reviewer_ref: "operator:tom".to_owned(),
            source_ref_count: 1,
            link_ref_count: 2,
            evidence_ref_count: 1,
            supersedes_count: 0,
            superseded_by_count: 0,
        }],
        vec![ControlAcceptedMemoryStatusCountDto {
            status: "accepted".to_owned(),
            count: 1,
        }],
        vec![ControlAcceptedMemoryScopeCountDto {
            scope: "project".to_owned(),
            count: 1,
        }],
        vec![ControlAcceptedMemoryKindCountDto {
            kind: "decision".to_owned(),
            count: 1,
        }],
        vec![ControlAcceptedMemorySensitivityCountDto {
            sensitivity: "internal_project".to_owned(),
            count: 1,
        }],
        vec![ControlAcceptedMemoryRetentionCountDto {
            retention: "project_context_candidate".to_owned(),
            count: 1,
        }],
        vec![ControlAcceptedMemoryConfidenceCountDto {
            confidence: "high".to_owned(),
            count: 1,
        }],
        ControlAcceptedMemorySourceCountsDto {
            accepted_records: 1,
            out_of_scope_accepted_records: 0,
            skipped_records: 2,
            skipped_proposal_records: 1,
            skipped_unsupported_records: 0,
            skipped_decode_errors: 1,
            source_refs: 1,
            link_refs: 2,
            evidence_refs: 1,
            supersession_refs: 0,
        },
        false,
        false,
        false,
        false,
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=accepted-memory"));
    assert!(rendered.contains("project_id=project:nucleus-local"));
    assert!(rendered.contains("memories=1"));
    assert!(rendered.contains("skipped_records=2"));
    assert!(rendered.contains("projection_written=false"));
    assert!(rendered.contains("embedding_available=false"));
    assert!(rendered.contains("provider_sync_available=false"));
    assert!(rendered.contains("sensitivity name=internal_project count=1"));
    assert!(!rendered.contains("raw_transcript"));
    assert!(!rendered.contains("provider_payload"));
    assert!(!rendered.contains("private_memory_body"));
    assert!(!rendered.contains("terminal_stream"));
}
