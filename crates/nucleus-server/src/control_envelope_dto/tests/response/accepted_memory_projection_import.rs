use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_import_admission::{
    AcceptedMemoryProjectionImportAdmissionRecord, AcceptedMemoryProjectionImportAdmissionStatus,
    AcceptedMemoryProjectionImportCandidateRecord, AcceptedMemoryProjectionImportCandidateStatus,
    AcceptedMemoryProjectionImportCandidateSummary,
};
use crate::accepted_memory_projection_import_conflicts::{
    AcceptedMemoryProjectionImportConflictRecord, AcceptedMemoryProjectionImportConflictStatus,
};
use crate::accepted_memory_projection_import_diagnostics::{
    AcceptedMemoryProjectionImportDiagnosticCounts, AcceptedMemoryProjectionImportDiagnostics,
};
use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto, ServerControlRequestId,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerQueryResult,
};

#[test]
fn response_envelope_dto_serializes_import_diagnostics_without_payloads() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId(
            "request:dto:accepted-memory-projection-import".to_owned(),
        ),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(
            ServerQueryResult::AcceptedMemoryProjectionImportDiagnostics(
                AcceptedMemoryProjectionImportDiagnostics {
                    project_id: ProjectId("project:nucleus".to_owned()),
                    candidates: vec![candidate()],
                    admissions: vec![admission()],
                    conflicts: vec![conflict()],
                    counts: AcceptedMemoryProjectionImportDiagnosticCounts {
                        source_records: 1,
                        accepted_records: 1,
                        out_of_scope_accepted_records: 0,
                        skipped_records: 0,
                        skipped_proposal_records: 0,
                        skipped_unsupported_records: 0,
                        skipped_decode_errors: 0,
                        skipped_encode_errors: 0,
                        input_files: 1,
                        candidates: 1,
                        ready_candidates: 1,
                        blocked_candidates: 0,
                        admitted_imports: 1,
                        blocked_imports: 0,
                        no_conflicts: 0,
                        duplicate_noops: 1,
                        semantic_conflicts: 0,
                        policy_conflicts: 0,
                        blocked_conflicts: 0,
                        candidate_blockers: 0,
                        admission_blockers: 0,
                        conflict_blockers: 0,
                        file_refs: 1,
                    },
                    projected_file_read_performed: false,
                    active_memory_apply_performed: false,
                    scm_effect_performed: false,
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
        ControlResponseBodyDto::AcceptedMemoryProjectionImportDiagnostics { diagnostics }
            if diagnostics.project_id == "project:nucleus"
                && diagnostics.candidates.len() == 1
                && diagnostics.admissions.len() == 1
                && diagnostics.conflicts.len() == 1
                && diagnostics.candidates[0].status == "ready"
                && diagnostics.admissions[0].status == "admitted"
                && diagnostics.conflicts[0].status == "duplicate_noop"
                && diagnostics.counts.duplicate_noops == 1
                && !diagnostics.projected_file_read_performed
                && !diagnostics.active_memory_apply_performed
                && !diagnostics.scm_effect_performed
                && !diagnostics.embedding_available
                && !diagnostics.provider_sync_available
                && !diagnostics.task_mutation_performed
                && !diagnostics.ui_effect_performed
    ));
    assert!(json.contains("\"type\":\"accepted_memory_projection_import_diagnostics\""));
    assert!(!json.contains("raw_transcript"));
    assert!(!json.contains("provider_payload"));
    assert!(!json.contains("private_memory_body"));
    assert!(!json.contains("terminal_stream"));
}

fn candidate() -> AcceptedMemoryProjectionImportCandidateRecord {
    AcceptedMemoryProjectionImportCandidateRecord {
        candidate_ref: "accepted-memory-import-candidate:nucleus/memory/memory:nucleus:1.toml"
            .to_owned(),
        memory_id: Some("memory:nucleus:1".to_owned()),
        file_ref: "nucleus/memory/memory:nucleus:1.toml".to_owned(),
        status: AcceptedMemoryProjectionImportCandidateStatus::Ready,
        payload: None,
        summary: Some(summary()),
        blockers: Vec::new(),
        active_memory_apply_performed: false,
    }
}

fn admission() -> AcceptedMemoryProjectionImportAdmissionRecord {
    AcceptedMemoryProjectionImportAdmissionRecord {
        admission_ref: "accepted-memory-import-admission:candidate".to_owned(),
        candidate_ref: "accepted-memory-import-candidate:nucleus/memory/memory:nucleus:1.toml"
            .to_owned(),
        memory_id: Some("memory:nucleus:1".to_owned()),
        file_ref: "nucleus/memory/memory:nucleus:1.toml".to_owned(),
        status: AcceptedMemoryProjectionImportAdmissionStatus::Admitted,
        payload: None,
        blockers: Vec::new(),
        active_memory_apply_performed: false,
        scm_effect_performed: false,
        embedding_available: false,
        provider_sync_available: false,
        task_mutation_performed: false,
        ui_effect_performed: false,
    }
}

fn conflict() -> AcceptedMemoryProjectionImportConflictRecord {
    AcceptedMemoryProjectionImportConflictRecord {
        conflict_ref: "accepted-memory-import-conflict:admission".to_owned(),
        admission_ref: "accepted-memory-import-admission:candidate".to_owned(),
        candidate_ref: "accepted-memory-import-candidate:nucleus/memory/memory:nucleus:1.toml"
            .to_owned(),
        memory_id: Some("memory:nucleus:1".to_owned()),
        file_ref: "nucleus/memory/memory:nucleus:1.toml".to_owned(),
        status: AcceptedMemoryProjectionImportConflictStatus::DuplicateNoop,
        summary: Some(summary()),
        blockers: Vec::new(),
        active_memory_apply_performed: false,
    }
}

fn summary() -> AcceptedMemoryProjectionImportCandidateSummary {
    AcceptedMemoryProjectionImportCandidateSummary {
        title: "Reviewed memory".to_owned(),
        body_kind: "summary".to_owned(),
        body_summary: "Sanitized summary only".to_owned(),
    }
}
