use crate::provider_no_effects::{MemoryApplyNoEffects};
use nucleus_core::PersistenceRecordId;
use nucleus_local_store::SqliteBackend;
use nucleus_memory::{
    AcceptedMemoryReviewReceiptDecisionStorage, AcceptedMemoryReviewReceiptStatusStorage,
};
use nucleus_projects::ProjectId;

use super::*;
use crate::accepted_memory_import_apply_review_command::{
    AcceptedMemoryImportApplyReviewDecision, AcceptedMemoryImportApplyReviewReceipt,
    AcceptedMemoryImportApplyReviewStatus,
};
use crate::accepted_memory_projection_import_apply_admission::AcceptedMemoryProjectionImportApplyAdmissionStatus;
use crate::state::ServerStateService;

#[test]
fn persists_sanitized_review_receipt_and_duplicate_is_noop() {
    let (_temp_dir, state) = state();
    let receipt = review_receipt();

    let first = persist_accepted_memory_review_receipt(
        &state,
        ProjectId("project:nucleus".to_owned()),
        &receipt,
    )
    .expect("persist receipt");
    let second = persist_accepted_memory_review_receipt(
        &state,
        ProjectId("project:nucleus".to_owned()),
        &receipt,
    )
    .expect("duplicate receipt");

    assert_eq!(
        first.status,
        AcceptedMemoryReviewReceiptPersistenceStatus::Persisted
    );
    assert_eq!(
        second.status,
        AcceptedMemoryReviewReceiptPersistenceStatus::DuplicateNoop
    );
    assert!(first.no_effects.review_receipt_written);
    assert!(!second.no_effects.review_receipt_written);
    assert!(!first.no_effects.no_effects.active_memory_apply_performed);
    assert!(!first.no_effects.no_effects.projection_write_performed);
    assert!(!first.no_effects.no_effects.scm_effect_performed);

    let stored = state
        .shared_memory()
        .get(&PersistenceRecordId(receipt.review_receipt_ref.clone()))
        .expect("get stored")
        .expect("stored receipt");
    let decoded = decode_persisted_accepted_memory_review_receipt(&stored).expect("decode");

    assert_eq!(decoded.project_id, "project:nucleus");
    assert_eq!(
        decoded.decision,
        AcceptedMemoryReviewReceiptDecisionStorage::Approve
    );
    assert_eq!(
        decoded.status,
        AcceptedMemoryReviewReceiptStatusStorage::Approved
    );
    assert_eq!(decoded.memory_id, "memory:1");
}

#[test]
fn different_duplicate_payload_is_conflict() {
    let (_temp_dir, state) = state();
    let receipt = review_receipt();
    persist_accepted_memory_review_receipt(
        &state,
        ProjectId("project:nucleus".to_owned()),
        &receipt,
    )
    .expect("persist receipt");

    let mut changed = receipt;
    changed.file_ref = "nucleus/memory/changed.toml".to_owned();
    let error = persist_accepted_memory_review_receipt(
        &state,
        ProjectId("project:nucleus".to_owned()),
        &changed,
    )
    .expect_err("conflict");

    assert!(matches!(error, ServerControlError::Conflict { .. }));
}

fn state() -> (tempfile::TempDir, ServerStateService<SqliteBackend>) {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    (temp_dir, ServerStateService::new(backend))
}

fn review_receipt() -> AcceptedMemoryImportApplyReviewReceipt {
    AcceptedMemoryImportApplyReviewReceipt {
        review_receipt_ref: "accepted-memory-import-apply-review:command:1".to_owned(),
        command_id: "command:1".to_owned(),
        apply_admission_ref: "apply-admission:1".to_owned(),
        import_admission_ref: "import-admission:1".to_owned(),
        conflict_ref: "conflict:1".to_owned(),
        candidate_ref: "candidate:1".to_owned(),
        memory_id: Some("memory:1".to_owned()),
        file_ref: "nucleus/memory/memory-1.toml".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        approval_ref: "approval:1".to_owned(),
        decision_reason_ref: String::new(),
        admission_status: AcceptedMemoryProjectionImportApplyAdmissionStatus::Admitted,
        admission_blockers: Vec::new(),
        decision: AcceptedMemoryImportApplyReviewDecision::Approve,
        status: AcceptedMemoryImportApplyReviewStatus::Approved,
        blockers: Vec::new(),
        provenance_refs: vec!["provenance:1".to_owned()],
        evidence_refs: vec!["evidence:1".to_owned()],
        no_effects: MemoryApplyNoEffects::none(),
    }
}
