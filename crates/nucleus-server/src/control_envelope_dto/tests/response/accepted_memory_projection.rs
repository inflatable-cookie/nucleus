use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_diagnostics::{
    AcceptedMemoryProjectionDiagnosticCounts, AcceptedMemoryProjectionDiagnosticEntry,
    AcceptedMemoryProjectionDiagnostics,
};
use crate::accepted_memory_projection_export_plan::{
    AcceptedMemoryProjectionExportBlocker, AcceptedMemoryProjectionExportStatus,
};
use crate::accepted_memory_projection_policy::{
    AcceptedMemoryProjectionPolicyBlocker, AcceptedMemoryProjectionPolicyStatus,
};
use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto, ServerControlRequestId,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerQueryResult,
};

#[test]
fn response_envelope_dto_serializes_accepted_memory_projection_without_bodies_or_effects() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:accepted-memory-projection".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(
            ServerQueryResult::AcceptedMemoryProjectionDiagnostics(
                AcceptedMemoryProjectionDiagnostics {
                    project_id: ProjectId("project:nucleus".to_owned()),
                    entries: vec![AcceptedMemoryProjectionDiagnosticEntry {
                        memory_id: "memory:nucleus:1".to_owned(),
                        plan_ref: "accepted-memory-export-plan:memory:nucleus:1".to_owned(),
                        file_ref: Some("nucleus/memory/memory:nucleus:1.toml".to_owned()),
                        export_status: AcceptedMemoryProjectionExportStatus::Blocked,
                        policy_status: AcceptedMemoryProjectionPolicyStatus::ReviewRequired,
                        policy_blockers: vec![
                            AcceptedMemoryProjectionPolicyBlocker::MissingReviewEvidence,
                        ],
                        export_blockers: vec![AcceptedMemoryProjectionExportBlocker::PolicyDenied],
                    }],
                    counts: AcceptedMemoryProjectionDiagnosticCounts {
                        accepted_records: 1,
                        out_of_scope_accepted_records: 0,
                        projectable_records: 0,
                        local_only_records: 0,
                        blocked_records: 0,
                        review_required_records: 1,
                        skipped_records: 2,
                        skipped_proposal_records: 1,
                        skipped_unsupported_records: 0,
                        skipped_decode_errors: 1,
                        policy_blockers: 1,
                        export_blockers: 1,
                        file_refs: 1,
                    },
                    projection_write_performed: false,
                    scm_effect_performed: false,
                    import_or_apply_performed: false,
                    embedding_available: false,
                    provider_sync_available: false,
                },
            ),
        ),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::AcceptedMemoryProjectionDiagnostics { diagnostics }
            if diagnostics.project_id == "project:nucleus"
                && diagnostics.entries.len() == 1
                && diagnostics.entries[0].policy_status == "review_required"
                && diagnostics.entries[0].policy_blockers[0].kind == "missing_review_evidence"
                && diagnostics.entries[0].export_blockers[0].kind == "policy_denied"
                && diagnostics.counts.accepted_records == 1
                && diagnostics.counts.skipped_records == 2
                && !diagnostics.projection_write_performed
                && !diagnostics.scm_effect_performed
                && !diagnostics.import_or_apply_performed
                && !diagnostics.embedding_available
                && !diagnostics.provider_sync_available
    ));
    assert!(json.contains("\"type\":\"accepted_memory_projection_diagnostics\""));
    assert!(json.contains("nucleus/memory/memory:nucleus:1.toml"));
    assert!(!json.contains("Hidden accepted memory body"));
    assert!(!json.contains("raw_transcript"));
    assert!(!json.contains("provider_payload"));
    assert!(!json.contains("private_memory_body"));
}
