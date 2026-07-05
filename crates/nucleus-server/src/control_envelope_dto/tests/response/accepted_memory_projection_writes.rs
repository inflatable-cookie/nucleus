use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_export_plan::AcceptedMemoryProjectionExportStatus;
use crate::accepted_memory_projection_policy::AcceptedMemoryProjectionPolicyStatus;
use crate::accepted_memory_projection_write_admission::AcceptedMemoryProjectionWriteAdmissionStatus;
use crate::accepted_memory_projection_write_diagnostics::{
    AcceptedMemoryProjectionMaterializationDiagnosticStatus, AcceptedMemoryProjectionPayloadStatus,
    AcceptedMemoryProjectionWriteDiagnosticCounts, AcceptedMemoryProjectionWriteDiagnosticEntry,
    AcceptedMemoryProjectionWriteDiagnostics,
};
use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto, ServerControlRequestId,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerQueryResult,
};

#[test]
fn response_envelope_dto_serializes_projection_write_diagnostics_without_bodies() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId(
            "request:dto:accepted-memory-projection-writes".to_owned(),
        ),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(
            ServerQueryResult::AcceptedMemoryProjectionWriteDiagnostics(
                AcceptedMemoryProjectionWriteDiagnostics {
                    project_id: ProjectId("project:nucleus".to_owned()),
                    entries: vec![AcceptedMemoryProjectionWriteDiagnosticEntry {
                        memory_id: "memory:nucleus:1".to_owned(),
                        plan_ref: "accepted-memory-export-plan:memory:nucleus:1".to_owned(),
                        file_ref: Some("nucleus/memory/memory:nucleus:1.toml".to_owned()),
                        policy_status: AcceptedMemoryProjectionPolicyStatus::Projectable,
                        export_status: AcceptedMemoryProjectionExportStatus::Stopped,
                        admission_status: AcceptedMemoryProjectionWriteAdmissionStatus::Admitted,
                        payload_status: AcceptedMemoryProjectionPayloadStatus::Ready,
                        materialization_status:
                            AcceptedMemoryProjectionMaterializationDiagnosticStatus::NotRun,
                        policy_blockers: Vec::new(),
                        export_blockers: Vec::new(),
                        admission_blockers: Vec::new(),
                        payload_blockers: Vec::new(),
                    }],
                    counts: AcceptedMemoryProjectionWriteDiagnosticCounts {
                        accepted_records: 1,
                        out_of_scope_accepted_records: 0,
                        admitted_writes: 1,
                        blocked_writes: 0,
                        payload_ready_records: 1,
                        payload_blocked_records: 0,
                        materialized_files: 0,
                        skipped_records: 0,
                        skipped_proposal_records: 0,
                        skipped_unsupported_records: 0,
                        skipped_decode_errors: 0,
                        policy_blockers: 0,
                        export_blockers: 0,
                        admission_blockers: 0,
                        payload_blockers: 0,
                        file_refs: 1,
                    },
                    projection_write_performed: false,
                    scm_effect_performed: false,
                    import_or_apply_performed: false,
                    embedding_available: false,
                    provider_sync_available: false,
                    task_mutation_performed: false,
                    ui_effect_performed: false,
                },
            ),
        ),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::AcceptedMemoryProjectionWriteDiagnostics { diagnostics }
            if diagnostics.project_id == "project:nucleus"
                && diagnostics.entries.len() == 1
                && diagnostics.entries[0].admission_status == "admitted"
                && diagnostics.entries[0].payload_status == "ready"
                && diagnostics.entries[0].materialization_status == "not_run"
                && diagnostics.counts.admitted_writes == 1
                && diagnostics.counts.materialized_files == 0
                && !diagnostics.projection_write_performed
                && !diagnostics.scm_effect_performed
                && !diagnostics.import_or_apply_performed
                && !diagnostics.embedding_available
                && !diagnostics.provider_sync_available
                && !diagnostics.task_mutation_performed
                && !diagnostics.ui_effect_performed
    ));
    assert!(json.contains("\"type\":\"accepted_memory_projection_write_diagnostics\""));
    assert!(!json.contains("Hidden accepted memory body"));
    assert!(!json.contains("raw_transcript"));
    assert!(!json.contains("provider_payload"));
    assert!(!json.contains("private_memory_body"));
}
