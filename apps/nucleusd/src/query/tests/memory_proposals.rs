use nucleus_server::{
    ControlMemoryProposalRetentionCountDto, ControlMemoryProposalScopeCountDto,
    ControlMemoryProposalSensitivityCountDto, ControlMemoryProposalSourceCountsDto,
    ControlMemoryProposalStatusCountDto, ControlMemoryProposalSummaryDto,
};

use super::*;

#[test]
fn memory_proposals_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::memory_proposals_response_lines(
        "memory-proposals",
        "project:nucleus-local".to_owned(),
        vec![ControlMemoryProposalSummaryDto {
            proposal_id: "memory-proposal:nucleus-local:bootstrap".to_owned(),
            scope: "project".to_owned(),
            kind: "decision".to_owned(),
            status: "proposed".to_owned(),
            review_status: "needs_human_review".to_owned(),
            sensitivity: "secret_adjacent".to_owned(),
            retention: "review_queue".to_owned(),
            source_ref_count: 1,
            link_ref_count: 2,
            supersedes_count: 0,
            superseded_by_count: 0,
        }],
        vec![ControlMemoryProposalStatusCountDto {
            status: "proposed".to_owned(),
            count: 1,
        }],
        vec![ControlMemoryProposalScopeCountDto {
            scope: "project".to_owned(),
            count: 1,
        }],
        vec![ControlMemoryProposalSensitivityCountDto {
            sensitivity: "secret_adjacent".to_owned(),
            count: 1,
        }],
        vec![ControlMemoryProposalRetentionCountDto {
            retention: "review_queue".to_owned(),
            count: 1,
        }],
        ControlMemoryProposalSourceCountsDto {
            proposal_records: 1,
            source_refs: 1,
            link_refs: 2,
            supersession_refs: 0,
        },
        false,
        false,
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=memory-proposals"));
    assert!(rendered.contains("project_id=project:nucleus-local"));
    assert!(rendered.contains("proposals=1"));
    assert!(rendered.contains("client_can_mutate=false"));
    assert!(rendered.contains("provider_execution_available=false"));
    assert!(rendered.contains("sensitivity name=secret_adjacent count=1"));
    assert!(!rendered.contains("raw_transcript"));
    assert!(!rendered.contains("provider_payload"));
    assert!(!rendered.contains("private_memory_body"));
    assert!(!rendered.contains("terminal_stream"));
}
