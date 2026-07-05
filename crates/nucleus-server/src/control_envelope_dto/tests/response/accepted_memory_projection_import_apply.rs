use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_import_apply_admission::{
    AcceptedMemoryProjectionImportApplyAdmissionBlocker,
    AcceptedMemoryProjectionImportApplyAdmissionRecord,
    AcceptedMemoryProjectionImportApplyAdmissionStatus,
};
use crate::accepted_memory_projection_import_apply_diagnostics::{
    AcceptedMemoryProjectionImportApplyDiagnosticCounts,
    AcceptedMemoryProjectionImportApplyDiagnostics,
};
use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto, ServerControlRequestId,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerQueryResult,
};

#[test]
fn response_envelope_dto_serializes_import_apply_diagnostics_without_payloads() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:accepted-memory-import-apply".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(
            ServerQueryResult::AcceptedMemoryProjectionImportApplyDiagnostics(
                AcceptedMemoryProjectionImportApplyDiagnostics {
                    diagnostics_id: "accepted-memory-import-apply-diagnostics".to_owned(),
                    project_id: ProjectId("project:nucleus".to_owned()),
                    records: vec![record()],
                    counts: AcceptedMemoryProjectionImportApplyDiagnosticCounts {
                        source_records: 1,
                        import_conflicts: 1,
                        apply_admissions: 1,
                        admitted: 0,
                        duplicate_noops: 0,
                        blocked: 1,
                        blockers: 2,
                        missing_ref_blockers: 2,
                        conflict_blockers: 0,
                        raw_payload_blockers: 0,
                        effect_blockers: 0,
                        provenance_refs: 1,
                        evidence_refs: 2,
                    },
                    active_memory_apply_performed: false,
                    projection_write_performed: false,
                    scm_effect_performed: false,
                    embedding_available: false,
                    provider_sync_available: false,
                    automatic_extraction_performed: false,
                    task_mutation_performed: false,
                    agent_scheduling_performed: false,
                    ui_effect_performed: false,
                },
            ),
        ),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::AcceptedMemoryProjectionImportApplyDiagnostics { diagnostics }
            if diagnostics.project_id == "project:nucleus"
                && diagnostics.records.len() == 1
                && diagnostics.records[0].status == "blocked"
                && diagnostics.records[0].blockers[0].kind == "missing_operator_ref"
                && diagnostics.counts.blocked == 1
                && !diagnostics.active_memory_apply_performed
                && !diagnostics.projection_write_performed
                && !diagnostics.scm_effect_performed
                && !diagnostics.embedding_available
                && !diagnostics.provider_sync_available
                && !diagnostics.automatic_extraction_performed
                && !diagnostics.task_mutation_performed
                && !diagnostics.agent_scheduling_performed
                && !diagnostics.ui_effect_performed
    ));
    assert!(json.contains("\"type\":\"accepted_memory_projection_import_apply_diagnostics\""));
    assert!(!json.contains("raw_transcript"));
    assert!(!json.contains("provider_payload"));
    assert!(!json.contains("private_memory_body"));
    assert!(!json.contains("terminal_stream"));
}

fn record() -> AcceptedMemoryProjectionImportApplyAdmissionRecord {
    AcceptedMemoryProjectionImportApplyAdmissionRecord {
        apply_admission_ref: "accepted-memory-import-apply-admission:request:1".to_owned(),
        request_id: "request:1".to_owned(),
        import_admission_ref: "accepted-memory-import-admission:candidate".to_owned(),
        conflict_ref: "accepted-memory-import-conflict:admission".to_owned(),
        candidate_ref: "accepted-memory-import-candidate:nucleus/memory/memory:1.toml".to_owned(),
        memory_id: Some("memory:1".to_owned()),
        file_ref: "nucleus/memory/memory:1.toml".to_owned(),
        operator_ref: String::new(),
        approval_ref: String::new(),
        provenance_refs: vec!["nucleus/memory/memory:1.toml".to_owned()],
        evidence_refs: vec!["candidate:1".to_owned(), "admission:1".to_owned()],
        status: AcceptedMemoryProjectionImportApplyAdmissionStatus::Blocked,
        blockers: vec![
            AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingOperatorRef,
            AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingApprovalRef,
        ],
        active_memory_apply_performed: false,
        projection_write_performed: false,
        scm_effect_performed: false,
        embedding_available: false,
        provider_sync_available: false,
        automatic_extraction_performed: false,
        task_mutation_performed: false,
        agent_scheduling_performed: false,
        ui_effect_performed: false,
    }
}
