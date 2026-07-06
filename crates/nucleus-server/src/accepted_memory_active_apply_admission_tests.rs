use nucleus_memory::{
    AcceptedMemoryReviewReceiptAdmissionStatusStorage, AcceptedMemoryReviewReceiptDecisionStorage,
    AcceptedMemoryReviewReceiptStatusStorage, AcceptedMemoryReviewReceiptStorageRecord,
};

use crate::accepted_memory_active_apply_admission::{
    accepted_memory_active_apply_admissions, AcceptedMemoryActiveApplyAdmissionBlocker,
    AcceptedMemoryActiveApplyAdmissionInput, AcceptedMemoryActiveApplyAdmissionStatus,
};

#[test]
fn approved_durable_review_receipt_is_admitted_without_effects() {
    let set = accepted_memory_active_apply_admissions(vec![active_apply_input(review_receipt())]);

    assert_eq!(set.counts.inputs, 1);
    assert_eq!(set.counts.admitted, 1);
    assert_eq!(
        set.records[0].status,
        AcceptedMemoryActiveApplyAdmissionStatus::Admitted
    );
    assert_eq!(
        set.records[0].active_apply_admission_ref,
        "accepted-memory-active-apply-admission:request:active-apply:1"
    );
    assert_eq!(
        set.records[0].review_receipt_id,
        "accepted-memory-import-apply-review:command:1"
    );
    assert_eq!(set.records[0].memory_id, "memory:1");
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

#[test]
fn deferred_rejected_and_blocked_reviews_are_not_admitted() {
    let mut deferred = review_receipt();
    deferred.decision = AcceptedMemoryReviewReceiptDecisionStorage::Defer;
    deferred.status = AcceptedMemoryReviewReceiptStatusStorage::Deferred;
    deferred.decision_reason_ref = Some("reason:defer".to_owned());
    let mut rejected = review_receipt();
    rejected.decision = AcceptedMemoryReviewReceiptDecisionStorage::Reject;
    rejected.status = AcceptedMemoryReviewReceiptStatusStorage::Rejected;
    rejected.decision_reason_ref = Some("reason:reject".to_owned());
    let mut blocked = review_receipt();
    blocked.status = AcceptedMemoryReviewReceiptStatusStorage::Blocked;

    let set = accepted_memory_active_apply_admissions(vec![
        active_apply_input(deferred),
        active_apply_input(rejected),
        active_apply_input(blocked),
    ]);

    assert_eq!(set.counts.blocked, 3);
    assert_eq!(set.counts.review_state_blockers, 6);
    assert!(set.records[0]
        .blockers
        .contains(&AcceptedMemoryActiveApplyAdmissionBlocker::ReviewDeferred));
    assert!(set.records[1]
        .blockers
        .contains(&AcceptedMemoryActiveApplyAdmissionBlocker::ReviewRejected));
    assert!(set.records[2]
        .blockers
        .contains(&AcceptedMemoryActiveApplyAdmissionBlocker::ReviewBlocked));
    assert!(set.records.iter().all(|record| {
        !record.active_memory_apply_performed
            && !record.projection_write_performed
            && !record.scm_effect_performed
    }));
}

#[test]
fn stale_requested_refs_are_blocked() {
    let mut input = active_apply_input(review_receipt());
    input.expected_apply_admission_ref = "apply:stale".to_owned();
    input.expected_import_admission_ref = "import:stale".to_owned();
    input.expected_conflict_ref = "conflict:stale".to_owned();
    input.expected_candidate_ref = "candidate:stale".to_owned();
    input.expected_memory_id = "memory:stale".to_owned();
    input.expected_file_ref = "nucleus/memory/stale.toml".to_owned();
    input.provenance_refs = vec!["provenance:stale".to_owned()];
    input.evidence_refs = vec!["evidence:stale".to_owned()];

    let set = accepted_memory_active_apply_admissions(vec![input]);

    assert_eq!(set.counts.blocked, 1);
    assert_eq!(set.counts.stale_ref_blockers, 8);
    assert!(set.records[0]
        .blockers
        .contains(&AcceptedMemoryActiveApplyAdmissionBlocker::StaleMemoryId));
    assert!(set.records[0]
        .blockers
        .contains(&AcceptedMemoryActiveApplyAdmissionBlocker::StaleEvidenceRefs));
}

#[test]
fn missing_refs_and_effect_requests_are_blocked() {
    let mut input = active_apply_input(review_receipt());
    input.request_id.clear();
    input.operator_ref.clear();
    input.approval_ref.clear();
    input.expected_apply_admission_ref.clear();
    input.expected_import_admission_ref.clear();
    input.expected_conflict_ref.clear();
    input.expected_candidate_ref.clear();
    input.expected_memory_id.clear();
    input.expected_file_ref.clear();
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

    let set = accepted_memory_active_apply_admissions(vec![input]);

    assert_eq!(set.counts.blocked, 1);
    assert!(set.counts.missing_ref_blockers >= 10);
    assert_eq!(set.counts.raw_payload_blockers, 1);
    assert_eq!(set.counts.effect_blockers, 9);
    assert!(set.records[0]
        .blockers
        .contains(&AcceptedMemoryActiveApplyAdmissionBlocker::ActiveMemoryMutationRequested));
    assert!(!set.records[0].active_memory_apply_performed);
}

#[test]
fn duplicate_source_admission_cannot_grant_active_apply() {
    let mut receipt = review_receipt();
    receipt.admission_status = AcceptedMemoryReviewReceiptAdmissionStatusStorage::DuplicateNoop;

    let set = accepted_memory_active_apply_admissions(vec![active_apply_input(receipt)]);

    assert_eq!(set.counts.duplicate_noops, 1);
    assert!(set.records[0]
        .blockers
        .contains(&AcceptedMemoryActiveApplyAdmissionBlocker::ReviewAdmissionDuplicateNoop));
    assert!(!set.records[0].active_memory_apply_performed);
}

fn active_apply_input(
    review_receipt: AcceptedMemoryReviewReceiptStorageRecord,
) -> AcceptedMemoryActiveApplyAdmissionInput {
    AcceptedMemoryActiveApplyAdmissionInput {
        request_id: "request:active-apply:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        approval_ref: "approval:active-apply:1".to_owned(),
        expected_apply_admission_ref: review_receipt.apply_admission_ref.clone(),
        expected_import_admission_ref: review_receipt.import_admission_ref.clone(),
        expected_conflict_ref: review_receipt.conflict_ref.clone(),
        expected_candidate_ref: review_receipt.candidate_ref.clone(),
        expected_memory_id: review_receipt.memory_id.clone(),
        expected_file_ref: review_receipt.file_ref.clone(),
        provenance_refs: review_receipt.provenance_refs.clone(),
        evidence_refs: review_receipt.evidence_refs.clone(),
        review_receipt,
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

fn review_receipt() -> AcceptedMemoryReviewReceiptStorageRecord {
    AcceptedMemoryReviewReceiptStorageRecord {
        schema_version: 1,
        review_receipt_id: "accepted-memory-import-apply-review:command:1".to_owned(),
        project_id: "project:nucleus".to_owned(),
        command_id: "command:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        approval_ref: Some("approval:review:1".to_owned()),
        decision_reason_ref: None,
        apply_admission_ref: "apply-admission:1".to_owned(),
        import_admission_ref: "import-admission:1".to_owned(),
        conflict_ref: "conflict:1".to_owned(),
        candidate_ref: "candidate:1".to_owned(),
        memory_id: "memory:1".to_owned(),
        file_ref: "nucleus/memory/memory-1.toml".to_owned(),
        provenance_refs: vec!["provenance:1".to_owned()],
        evidence_refs: vec!["evidence:1".to_owned()],
        decision: AcceptedMemoryReviewReceiptDecisionStorage::Approve,
        status: AcceptedMemoryReviewReceiptStatusStorage::Approved,
        admission_status: AcceptedMemoryReviewReceiptAdmissionStatusStorage::Admitted,
        blockers: Vec::new(),
        admission_blockers: Vec::new(),
        reviewed_at: None,
        updated_at: None,
    }
}
