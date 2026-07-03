use nucleus_projects::ProjectId;

use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto, MemoryProposalRetention,
    MemoryProposalRetentionCount, MemoryProposalReviewStatus, MemoryProposalScopeCount,
    MemoryProposalSensitivity, MemoryProposalSensitivityCount, MemoryProposalSourceCounts,
    MemoryProposalStatusCount, MemoryProposalSummary, MemoryProposalSummaryKind,
    MemoryProposalSummaryScope, MemoryProposalSummaryStatus, MemoryProposalsProjection,
    ServerControlRequestId, ServerControlResponse, ServerControlResponseBody,
    ServerControlResponseStatus, ServerQueryResult,
};

#[test]
fn response_envelope_dto_serializes_memory_proposals_without_bodies_or_effects() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:memory-proposals".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::MemoryProposals(
            MemoryProposalsProjection {
                project_id: ProjectId("project:nucleus".to_owned()),
                proposals: vec![MemoryProposalSummary {
                    proposal_id: "memory-proposal:nucleus:1".to_owned(),
                    scope: MemoryProposalSummaryScope::Project,
                    kind: MemoryProposalSummaryKind::Decision,
                    status: MemoryProposalSummaryStatus::Proposed,
                    review_status: MemoryProposalReviewStatus::NeedsHumanReview,
                    sensitivity: MemoryProposalSensitivity::SecretAdjacent,
                    retention: MemoryProposalRetention::ReviewQueue,
                    source_ref_count: 1,
                    link_ref_count: 2,
                    supersedes_count: 1,
                    superseded_by_count: 0,
                }],
                status_counts: vec![MemoryProposalStatusCount {
                    status: MemoryProposalSummaryStatus::Proposed,
                    count: 1,
                }],
                scope_counts: vec![MemoryProposalScopeCount {
                    scope: MemoryProposalSummaryScope::Project,
                    count: 1,
                }],
                sensitivity_counts: vec![MemoryProposalSensitivityCount {
                    sensitivity: MemoryProposalSensitivity::SecretAdjacent,
                    count: 1,
                }],
                retention_counts: vec![MemoryProposalRetentionCount {
                    retention: MemoryProposalRetention::ReviewQueue,
                    count: 1,
                }],
                source_counts: MemoryProposalSourceCounts {
                    proposal_records: 1,
                    source_refs: 1,
                    link_refs: 2,
                    supersession_refs: 1,
                },
                client_can_mutate: false,
                provider_execution_available: false,
            },
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::MemoryProposals {
            project_id,
            proposals,
            source_counts,
            client_can_mutate,
            provider_execution_available,
            ..
        } if project_id == "project:nucleus"
            && proposals.len() == 1
            && proposals[0].proposal_id == "memory-proposal:nucleus:1"
            && source_counts.proposal_records == 1
            && source_counts.link_refs == 2
            && !client_can_mutate
            && !provider_execution_available
    ));
    assert!(json.contains("\"type\":\"memory_proposals\""));
    assert!(!json.contains("Hidden from projection"));
    assert!(!json.contains("raw_transcript"));
    assert!(!json.contains("provider_payload"));
    assert!(!json.contains("private_memory_body"));
}
