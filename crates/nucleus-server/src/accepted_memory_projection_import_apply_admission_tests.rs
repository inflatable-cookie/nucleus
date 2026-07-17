use nucleus_memory::AcceptedMemoryStorageBody;
use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_import_admission::{
    accepted_memory_projection_import_admissions, AcceptedMemoryProjectionImportInput,
};
use crate::accepted_memory_projection_import_apply_admission::{
    accepted_memory_projection_import_apply_admissions,
    AcceptedMemoryProjectionImportApplyAdmissionBlocker,
    AcceptedMemoryProjectionImportApplyAdmissionInput,
    AcceptedMemoryProjectionImportApplyAdmissionStatus,
};
use crate::accepted_memory_projection_import_conflicts::{
    accepted_memory_projection_import_conflicts, AcceptedMemoryProjectionImportConflictRecord,
};
use crate::accepted_memory_projection_payload::{
    encode_accepted_memory_projection_payload, AcceptedMemoryProjectionPayload,
};
use crate::accepted_memory_projection_test_fixtures::accepted_memory;

#[test]
fn no_conflict_import_is_admitted_without_effects() {
    let set = accepted_memory_projection_import_apply_admissions(vec![apply_input(
        "request:ready",
        no_conflict("memory:new"),
    )]);

    assert_eq!(set.counts.inputs, 1);
    assert_eq!(set.counts.admitted, 1);
    assert_eq!(
        set.records[0].status,
        AcceptedMemoryProjectionImportApplyAdmissionStatus::Admitted
    );
    assert_eq!(
        set.records[0].apply_admission_ref,
        "accepted-memory-import-apply-admission:request:ready"
    );
    assert!(!set.no_effects.active_memory_apply_performed);
    assert!(!set.no_effects.projection_write_performed);
    assert!(!set.no_effects.scm_effect_performed);
    assert!(!set.no_effects.embedding_available);
    assert!(!set.no_effects.provider_sync_available);
    assert!(!set.no_effects.automatic_extraction_performed);
    assert!(!set.no_effects.task_mutation_performed);
    assert!(!set.no_effects.agent_scheduling_performed);
    assert!(!set.no_effects.ui_effect_performed);
}

#[test]
fn duplicate_noop_is_explicit_and_does_not_receive_apply_authority() {
    let active = accepted_memory("memory:noop");
    let conflict = import_conflict("memory:noop", &[active]);
    let set = accepted_memory_projection_import_apply_admissions(vec![apply_input(
        "request:noop",
        conflict,
    )]);

    assert_eq!(set.counts.duplicate_noops, 1);
    assert_eq!(
        set.records[0].status,
        AcceptedMemoryProjectionImportApplyAdmissionStatus::DuplicateNoop
    );
    assert!(set.records[0]
        .blockers
        .contains(&AcceptedMemoryProjectionImportApplyAdmissionBlocker::DuplicateNoop));
    assert!(!set.records[0].no_effects.active_memory_apply_performed);
}

#[test]
fn semantic_conflict_missing_refs_and_effect_requests_are_blocked() {
    let mut active = accepted_memory("memory:conflict");
    active.body = AcceptedMemoryStorageBody::Summary {
        summary: "Different active body".to_owned(),
        detail: None,
    };
    let mut input = apply_input(" ", import_conflict("memory:conflict", &[active]));
    input.operator_ref.clear();
    input.approval_ref.clear();
    input.provenance_refs.clear();
    input.evidence_refs.clear();
    input.raw_payload_present = true;
    input.active_memory_mutation_requested = true;
    input.projection_write_requested = true;
    input.scm_effect_requested = true;
    input.embedding_requested = true;
    input.provider_sync_requested = true;
    input.automatic_extraction_requested = true;
    input.task_mutation_requested = true;
    input.agent_scheduling_requested = true;
    input.ui_effect_requested = true;

    let set = accepted_memory_projection_import_apply_admissions(vec![input]);

    assert_eq!(set.counts.blocked, 1);
    assert_eq!(set.counts.raw_payload_blockers, 1);
    assert_eq!(set.counts.effect_blockers, 9);
    assert!(set.counts.missing_ref_blockers >= 4);
    assert!(set.records[0].blockers.contains(
        &AcceptedMemoryProjectionImportApplyAdmissionBlocker::UnresolvedSemanticConflict
    ));
    assert!(set.records[0].blockers.contains(
        &AcceptedMemoryProjectionImportApplyAdmissionBlocker::ActiveMemoryMutationRequested
    ));
    assert!(!set.records[0].no_effects.active_memory_apply_performed);
}

#[test]
fn blocked_import_conflict_is_not_admitted() {
    let mut conflict = no_conflict("memory:blocked");
    conflict.memory_id = None;
    conflict.file_ref.clear();

    let set = accepted_memory_projection_import_apply_admissions(vec![apply_input(
        "request:blocked",
        conflict,
    )]);

    assert_eq!(set.counts.blocked, 1);
    assert!(set.records[0]
        .blockers
        .contains(&AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingMemoryId));
    assert!(set.records[0]
        .blockers
        .contains(&AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingFileRef));
}

fn apply_input(
    request_id: &str,
    conflict: AcceptedMemoryProjectionImportConflictRecord,
) -> AcceptedMemoryProjectionImportApplyAdmissionInput {
    AcceptedMemoryProjectionImportApplyAdmissionInput {
        request_id: request_id.to_owned(),
        operator_ref: "operator:tom".to_owned(),
        approval_ref: "approval:accepted-memory-import:1".to_owned(),
        provenance_refs: vec![
            "projection-file:nucleus/memory".to_owned(),
            "projection-file:nucleus/memory".to_owned(),
        ],
        evidence_refs: vec!["evidence:accepted-memory-import:1".to_owned()],
        conflict,
        raw_payload_present: false,
        active_memory_mutation_requested: false,
        projection_write_requested: false,
        scm_effect_requested: false,
        embedding_requested: false,
        provider_sync_requested: false,
        automatic_extraction_requested: false,
        task_mutation_requested: false,
        agent_scheduling_requested: false,
        ui_effect_requested: false,
    }
}

fn no_conflict(memory_id: &str) -> AcceptedMemoryProjectionImportConflictRecord {
    import_conflict(memory_id, &[])
}

fn import_conflict(
    memory_id: &str,
    active_records: &[nucleus_memory::AcceptedMemoryStorageRecord],
) -> AcceptedMemoryProjectionImportConflictRecord {
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
