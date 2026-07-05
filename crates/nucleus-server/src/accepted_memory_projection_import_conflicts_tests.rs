use nucleus_memory::{
    AcceptedMemoryStorageBody, AcceptedMemorySupersessionStorageRefs,
    MemoryRetentionStoragePosture, MemorySensitivityStorage,
};
use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_import_admission::{
    accepted_memory_projection_import_admissions, AcceptedMemoryProjectionImportInput,
};
use crate::accepted_memory_projection_import_conflicts::{
    accepted_memory_projection_import_conflicts, AcceptedMemoryProjectionImportConflictBlocker,
    AcceptedMemoryProjectionImportConflictStatus,
};
use crate::accepted_memory_projection_payload::{
    encode_accepted_memory_projection_payload, AcceptedMemoryProjectionPayload,
};
use crate::accepted_memory_projection_test_fixtures::accepted_memory;

#[test]
fn admitted_import_with_no_active_match_has_no_conflict_and_no_effects() {
    let admissions = import_admissions(vec![projection_input("memory:new")]);
    let conflicts = accepted_memory_projection_import_conflicts(&admissions, &[]);

    assert_eq!(conflicts.counts.no_conflicts, 1);
    assert!(!conflicts.active_memory_apply_performed);
    assert!(!conflicts.scm_effect_performed);
    assert!(!conflicts.embedding_available);
    assert!(!conflicts.provider_sync_available);
    assert!(!conflicts.task_mutation_performed);
    assert!(!conflicts.ui_effect_performed);
    assert_eq!(
        conflicts.conflicts[0].status,
        AcceptedMemoryProjectionImportConflictStatus::NoConflict
    );
}

#[test]
fn matching_active_memory_is_staged_as_duplicate_noop() {
    let active = accepted_memory("memory:noop");
    let admissions = import_admissions(vec![projection_input("memory:noop")]);
    let conflicts = accepted_memory_projection_import_conflicts(&admissions, &[active]);

    assert_eq!(conflicts.counts.duplicate_noops, 1);
    assert_eq!(
        conflicts.conflicts[0].status,
        AcceptedMemoryProjectionImportConflictStatus::DuplicateNoop
    );
    assert!(conflicts.conflicts[0].blockers.is_empty());
}

#[test]
fn conflicting_body_is_staged_as_semantic_conflict() {
    let mut active = accepted_memory("memory:body-conflict");
    active.body = AcceptedMemoryStorageBody::Summary {
        summary: "Active body differs.".to_owned(),
        detail: None,
    };
    let admissions = import_admissions(vec![projection_input("memory:body-conflict")]);
    let conflicts = accepted_memory_projection_import_conflicts(&admissions, &[active]);

    assert_eq!(conflicts.counts.semantic_conflicts, 1);
    assert_eq!(
        conflicts.conflicts[0].status,
        AcceptedMemoryProjectionImportConflictStatus::SemanticConflict
    );
    assert!(conflicts.conflicts[0]
        .blockers
        .contains(&AcceptedMemoryProjectionImportConflictBlocker::BodyMismatch));
}

#[test]
fn conflicting_supersession_is_staged_as_semantic_conflict() {
    let mut active = accepted_memory("memory:supersession-conflict");
    active.supersession = AcceptedMemorySupersessionStorageRefs {
        supersedes: vec!["memory:old".to_owned()],
        superseded_by: Vec::new(),
    };
    let admissions = import_admissions(vec![projection_input("memory:supersession-conflict")]);
    let conflicts = accepted_memory_projection_import_conflicts(&admissions, &[active]);

    assert_eq!(conflicts.counts.semantic_conflicts, 1);
    assert!(conflicts.conflicts[0].blockers.iter().any(|blocker| {
        matches!(
            blocker,
            AcceptedMemoryProjectionImportConflictBlocker::SupersessionMismatch
        )
    }));
}

#[test]
fn sensitivity_or_retention_drift_is_staged_as_policy_conflict() {
    let mut active = accepted_memory("memory:policy-conflict");
    active.sensitivity = MemorySensitivityStorage::PublicProject;
    active.retention = MemoryRetentionStoragePosture::Archive;
    let admissions = import_admissions(vec![projection_input("memory:policy-conflict")]);
    let conflicts = accepted_memory_projection_import_conflicts(&admissions, &[active]);

    assert_eq!(conflicts.counts.policy_conflicts, 1);
    assert_eq!(
        conflicts.conflicts[0].status,
        AcceptedMemoryProjectionImportConflictStatus::PolicyConflict
    );
    assert!(conflicts.conflicts[0]
        .blockers
        .contains(&AcceptedMemoryProjectionImportConflictBlocker::SensitivityMismatch));
    assert!(conflicts.conflicts[0]
        .blockers
        .contains(&AcceptedMemoryProjectionImportConflictBlocker::RetentionMismatch));
}

#[test]
fn blocked_admission_remains_blocked_in_conflict_staging() {
    let mut payload = projection_payload("memory:blocked");
    payload.sensitivity = MemorySensitivityStorage::Restricted;
    let admissions = import_admissions(vec![input_from_payload(payload)]);
    let conflicts = accepted_memory_projection_import_conflicts(&admissions, &[]);

    assert_eq!(conflicts.counts.blocked, 1);
    assert!(conflicts.conflicts[0]
        .blockers
        .contains(&AcceptedMemoryProjectionImportConflictBlocker::AdmissionNotAdmitted));
    assert!(!conflicts.active_memory_apply_performed);
}

#[test]
fn conflict_records_expose_sanitized_summaries_only() {
    let admissions = import_admissions(vec![projection_input("memory:sanitized-conflict")]);
    let conflicts = accepted_memory_projection_import_conflicts(&admissions, &[]);
    let rendered = format!("{conflicts:?}");

    assert!(conflicts.conflicts[0].summary.is_some());
    for forbidden in [
        "raw_transcript",
        "provider_payload",
        "terminal_stream",
        "private_note",
        "credential",
        "secret_value",
    ] {
        assert!(
            !rendered.contains(forbidden),
            "conflict diagnostics leaked {forbidden}"
        );
    }
}

fn import_admissions(
    inputs: Vec<AcceptedMemoryProjectionImportInput>,
) -> Vec<crate::accepted_memory_projection_import_admission::AcceptedMemoryProjectionImportAdmissionRecord>
{
    accepted_memory_projection_import_admissions(ProjectId("project:nucleus".to_owned()), inputs)
        .admissions
}

fn projection_input(memory_id: &str) -> AcceptedMemoryProjectionImportInput {
    input_from_payload(projection_payload(memory_id))
}

fn projection_payload(memory_id: &str) -> AcceptedMemoryProjectionPayload {
    AcceptedMemoryProjectionPayload::from_accepted_memory_record(&accepted_memory(memory_id))
        .expect("projection payload")
}

fn input_from_payload(
    payload: AcceptedMemoryProjectionPayload,
) -> AcceptedMemoryProjectionImportInput {
    AcceptedMemoryProjectionImportInput {
        file_ref: format!("nucleus/memory/{}.toml", payload.memory_id),
        bytes: encode_accepted_memory_projection_payload(&payload).expect("encode"),
    }
}
