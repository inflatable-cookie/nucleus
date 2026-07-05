use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_import_admission::{
    accepted_memory_projection_import_admissions, AcceptedMemoryProjectionImportInput,
};
use crate::accepted_memory_projection_import_apply_admission::{
    AcceptedMemoryProjectionImportApplyAdmissionBlocker,
    AcceptedMemoryProjectionImportApplyAdmissionStatus,
};
use crate::accepted_memory_projection_import_apply_diagnostics::AcceptedMemoryProjectionImportApplyDiagnostics;
use crate::accepted_memory_projection_import_conflicts::accepted_memory_projection_import_conflicts;
use crate::accepted_memory_projection_import_diagnostics::AcceptedMemoryProjectionImportDiagnostics;
use crate::accepted_memory_projection_payload::{
    encode_accepted_memory_projection_payload, AcceptedMemoryProjectionPayload,
};
use crate::accepted_memory_projection_test_fixtures::accepted_memory;

#[test]
fn diagnostics_build_stopped_apply_records_without_effects_or_operator_approval() {
    let import_diagnostics = AcceptedMemoryProjectionImportDiagnostics {
        project_id: ProjectId("project:nucleus".to_owned()),
        candidates: Vec::new(),
        admissions: Vec::new(),
        conflicts: vec![no_conflict("memory:new")],
        counts: crate::AcceptedMemoryProjectionImportDiagnosticCounts {
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
            no_conflicts: 1,
            duplicate_noops: 0,
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
    };

    let diagnostics =
        AcceptedMemoryProjectionImportApplyDiagnostics::from_import_diagnostics(import_diagnostics);

    assert_eq!(diagnostics.counts.apply_admissions, 1);
    assert_eq!(diagnostics.counts.blocked, 1);
    assert_eq!(
        diagnostics.records[0].status,
        AcceptedMemoryProjectionImportApplyAdmissionStatus::Blocked
    );
    assert!(diagnostics.records[0]
        .blockers
        .contains(&AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingOperatorRef));
    assert!(diagnostics.records[0]
        .blockers
        .contains(&AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingApprovalRef));
    assert!(!diagnostics.active_memory_apply_performed);
    assert!(!diagnostics.projection_write_performed);
    assert!(!diagnostics.scm_effect_performed);
    assert!(!diagnostics.embedding_available);
    assert!(!diagnostics.provider_sync_available);
    assert!(!diagnostics.automatic_extraction_performed);
    assert!(!diagnostics.task_mutation_performed);
    assert!(!diagnostics.agent_scheduling_performed);
    assert!(!diagnostics.ui_effect_performed);
}

#[test]
fn diagnostics_keep_duplicate_noop_visible_without_applying_memory() {
    let active = accepted_memory("memory:noop");
    let import_diagnostics = AcceptedMemoryProjectionImportDiagnostics {
        project_id: ProjectId("project:nucleus".to_owned()),
        candidates: Vec::new(),
        admissions: Vec::new(),
        conflicts: vec![import_conflict("memory:noop", &[active])],
        counts: crate::AcceptedMemoryProjectionImportDiagnosticCounts {
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
    };

    let diagnostics =
        AcceptedMemoryProjectionImportApplyDiagnostics::from_import_diagnostics(import_diagnostics);

    assert_eq!(diagnostics.counts.blocked, 1);
    assert!(diagnostics.records[0]
        .blockers
        .contains(&AcceptedMemoryProjectionImportApplyAdmissionBlocker::DuplicateNoop));
    assert!(!diagnostics.records[0].active_memory_apply_performed);
}

fn no_conflict(memory_id: &str) -> crate::AcceptedMemoryProjectionImportConflictRecord {
    import_conflict(memory_id, &[])
}

fn import_conflict(
    memory_id: &str,
    active_records: &[nucleus_memory::AcceptedMemoryStorageRecord],
) -> crate::AcceptedMemoryProjectionImportConflictRecord {
    let admissions = accepted_memory_projection_import_admissions(
        ProjectId("project:nucleus".to_owned()),
        vec![projection_input(memory_id)],
    )
    .admissions;
    let conflicts = accepted_memory_projection_import_conflicts(&admissions, active_records);
    conflicts.conflicts[0].clone()
}

fn projection_input(memory_id: &str) -> AcceptedMemoryProjectionImportInput {
    let payload =
        AcceptedMemoryProjectionPayload::from_accepted_memory_record(&accepted_memory(memory_id))
            .expect("projection payload");
    AcceptedMemoryProjectionImportInput {
        file_ref: format!("nucleus/memory/{}.toml", payload.memory_id),
        bytes: encode_accepted_memory_projection_payload(&payload).expect("encode"),
    }
}
