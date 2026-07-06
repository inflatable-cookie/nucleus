use nucleus_projects::ProjectId;

use crate::accepted_memory_import_apply_review_command::{
    accepted_memory_import_apply_review_receipts, AcceptedMemoryImportApplyReviewBlocker,
    AcceptedMemoryImportApplyReviewDecision, AcceptedMemoryImportApplyReviewInput,
    AcceptedMemoryImportApplyReviewStatus,
};
use crate::accepted_memory_projection_import_admission::{
    accepted_memory_projection_import_admissions, AcceptedMemoryProjectionImportInput,
};
use crate::accepted_memory_projection_import_apply_admission::{
    accepted_memory_projection_import_apply_admissions,
    AcceptedMemoryProjectionImportApplyAdmissionInput,
};
use crate::accepted_memory_projection_import_conflicts::{
    accepted_memory_projection_import_conflicts, AcceptedMemoryProjectionImportConflictRecord,
};
use crate::accepted_memory_projection_payload::{
    encode_accepted_memory_projection_payload, AcceptedMemoryProjectionPayload,
};
use crate::accepted_memory_projection_test_fixtures::accepted_memory;

#[test]
fn approve_records_operator_approval_without_applying_memory() {
    let set = accepted_memory_import_apply_review_receipts(vec![review_input(
        "command:review:approve",
        AcceptedMemoryImportApplyReviewDecision::Approve,
        admitted_apply_record("memory:approve"),
    )]);

    assert_eq!(set.counts.inputs, 1);
    assert_eq!(set.counts.approved, 1);
    assert_eq!(
        set.receipts[0].status,
        AcceptedMemoryImportApplyReviewStatus::Approved
    );
    assert_eq!(
        set.receipts[0].review_receipt_ref,
        "accepted-memory-import-apply-review:command:review:approve"
    );
    assert_eq!(set.receipts[0].provenance_refs.len(), 1);
    assert_eq!(set.receipts[0].evidence_refs.len(), 1);
    assert_no_effects(&set);
}

#[test]
fn defer_and_reject_preserve_reason_and_do_not_require_approval_ref() {
    let mut defer_input = review_input(
        "command:review:defer",
        AcceptedMemoryImportApplyReviewDecision::Defer,
        admitted_apply_record("memory:defer"),
    );
    defer_input.approval_ref.clear();

    let mut reject_input = review_input(
        "command:review:reject",
        AcceptedMemoryImportApplyReviewDecision::Reject,
        admitted_apply_record("memory:reject"),
    );
    reject_input.approval_ref.clear();

    let set = accepted_memory_import_apply_review_receipts(vec![defer_input, reject_input]);

    assert_eq!(set.counts.deferred, 1);
    assert_eq!(set.counts.rejected, 1);
    assert_eq!(set.counts.blocked, 0);
    assert_eq!(set.receipts[0].decision_reason_ref, "review-reason:1");
    assert_no_effects(&set);
}

#[test]
fn approval_cannot_bypass_duplicate_or_blocked_admissions() {
    let active = accepted_memory("memory:noop");
    let duplicate_conflict = import_conflict("memory:noop", &[active]);
    let duplicate_record = apply_record("request:noop", duplicate_conflict);

    let set = accepted_memory_import_apply_review_receipts(vec![review_input(
        "command:review:noop",
        AcceptedMemoryImportApplyReviewDecision::Approve,
        duplicate_record,
    )]);

    assert_eq!(set.counts.blocked, 1);
    assert_eq!(set.counts.admission_blockers, 2);
    assert!(set.receipts[0]
        .blockers
        .contains(&AcceptedMemoryImportApplyReviewBlocker::AdmissionDuplicateNoop));
    assert!(set.receipts[0]
        .blockers
        .contains(&AcceptedMemoryImportApplyReviewBlocker::AdmissionBlockersPresent));
    assert_no_effects(&set);
}

#[test]
fn missing_refs_raw_payload_and_effect_requests_are_blocked() {
    let mut input = review_input(
        " ",
        AcceptedMemoryImportApplyReviewDecision::Approve,
        admitted_apply_record("memory:blockers"),
    );
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

    let set = accepted_memory_import_apply_review_receipts(vec![input]);

    assert_eq!(set.counts.blocked, 1);
    assert_eq!(set.counts.raw_payload_blockers, 1);
    assert_eq!(set.counts.effect_blockers, 9);
    assert!(set.counts.missing_ref_blockers >= 5);
    assert!(set.receipts[0]
        .blockers
        .contains(&AcceptedMemoryImportApplyReviewBlocker::ActiveMemoryMutationRequested));
    assert_no_effects(&set);
}

fn review_input(
    command_id: &str,
    decision: AcceptedMemoryImportApplyReviewDecision,
    admission: crate::AcceptedMemoryProjectionImportApplyAdmissionRecord,
) -> AcceptedMemoryImportApplyReviewInput {
    AcceptedMemoryImportApplyReviewInput {
        command_id: command_id.to_owned(),
        operator_ref: "operator:tom".to_owned(),
        approval_ref: "approval:accepted-memory-import-apply:1".to_owned(),
        decision_reason_ref: "review-reason:1".to_owned(),
        decision,
        provenance_refs: vec![
            "projection-file:nucleus/memory".to_owned(),
            "projection-file:nucleus/memory".to_owned(),
        ],
        evidence_refs: vec!["evidence:accepted-memory-import-apply-review:1".to_owned()],
        admission,
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

fn admitted_apply_record(
    memory_id: &str,
) -> crate::AcceptedMemoryProjectionImportApplyAdmissionRecord {
    apply_record("request:ready", import_conflict(memory_id, &[]))
}

fn apply_record(
    request_id: &str,
    conflict: AcceptedMemoryProjectionImportConflictRecord,
) -> crate::AcceptedMemoryProjectionImportApplyAdmissionRecord {
    let records =
        accepted_memory_projection_import_apply_admissions(vec![apply_input(request_id, conflict)])
            .records;
    records[0].clone()
}

fn apply_input(
    request_id: &str,
    conflict: AcceptedMemoryProjectionImportConflictRecord,
) -> AcceptedMemoryProjectionImportApplyAdmissionInput {
    AcceptedMemoryProjectionImportApplyAdmissionInput {
        request_id: request_id.to_owned(),
        operator_ref: "operator:tom".to_owned(),
        approval_ref: "approval:accepted-memory-import:1".to_owned(),
        provenance_refs: vec!["projection-file:nucleus/memory".to_owned()],
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

fn assert_no_effects(set: &crate::AcceptedMemoryImportApplyReviewSet) {
    assert!(!set.active_memory_apply_performed);
    assert!(!set.projection_write_performed);
    assert!(!set.scm_effect_performed);
    assert!(!set.embedding_available);
    assert!(!set.provider_sync_available);
    assert!(!set.automatic_extraction_performed);
    assert!(!set.task_mutation_performed);
    assert!(!set.agent_scheduling_performed);
    assert!(!set.ui_effect_performed);
}
