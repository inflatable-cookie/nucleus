use super::*;
use crate::{ScmCaptureDryRunReceiptRecord, ScmCaptureDryRunReceiptStatus};
use nucleus_local_store::SqliteBackend;

#[test]
fn scm_capture_dry_run_execution_persistence_records_round_trip_sanitized_record() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));

    let record = persist_scm_capture_dry_run_execution_receipt(
        &state,
        input(receipt("1", ScmCaptureDryRunReceiptStatus::Completed, true)),
    )
    .expect("persist");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records = read_scm_capture_dry_run_execution_receipts(&reopened).expect("read");

    assert_eq!(records, vec![record]);
    assert_eq!(records[0].changed_path_count, 2);
    assert!(records[0].scm_dry_run_executed);
    assert!(!records[0].scm_capture_executed);
    assert!(!records[0].raw_material_exposed);
}

#[test]
fn scm_capture_dry_run_execution_state_api_reads_records_in_stable_order() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

    persist_scm_capture_dry_run_execution_receipt(
        &state,
        input(receipt("b", ScmCaptureDryRunReceiptStatus::Accepted, false)),
    )
    .expect("persist b");
    persist_scm_capture_dry_run_execution_receipt(
        &state,
        input(receipt("a", ScmCaptureDryRunReceiptStatus::Accepted, false)),
    )
    .expect("persist a");

    let records = read_scm_capture_dry_run_execution_receipts(&state).expect("read");

    assert_eq!(records[0].receipt_id, "receipt:a");
    assert_eq!(records[1].receipt_id, "receipt:b");
}

#[test]
fn scm_capture_dry_run_execution_duplicate_blocked_preserves_terminal_outcomes() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

    let failed = persist_scm_capture_dry_run_execution_receipt(
        &state,
        input(receipt(
            "failed",
            ScmCaptureDryRunReceiptStatus::Failed,
            false,
        )),
    )
    .expect("persist failed");
    let repair = persist_scm_capture_dry_run_execution_receipt(
        &state,
        input(receipt(
            "repair",
            ScmCaptureDryRunReceiptStatus::RepairRequired,
            false,
        )),
    )
    .expect("persist repair");
    let duplicate = persist_scm_capture_dry_run_execution_receipt(
        &state,
        ScmCaptureDryRunExecutionPersistenceInput {
            existing_execution_receipt_ids: vec![failed.persisted_execution_receipt_id.clone()],
            ..input(receipt(
                "failed",
                ScmCaptureDryRunReceiptStatus::Completed,
                true,
            ))
        },
    )
    .expect("duplicate");

    assert_eq!(failed.outcome, ScmCaptureDryRunReceiptStatus::Failed);
    assert_eq!(
        repair.outcome,
        ScmCaptureDryRunReceiptStatus::RepairRequired
    );
    assert_eq!(
        duplicate.persistence_status,
        ScmCaptureDryRunExecutionPersistenceStatus::DuplicateNoop
    );
    assert!(duplicate.duplicate_execution_receipt_detected);
}

#[test]
fn scm_capture_dry_run_execution_duplicate_blocked_blocks_raw_or_external_requests() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let mut input = input(receipt(
        "blocked",
        ScmCaptureDryRunReceiptStatus::Completed,
        true,
    ));
    input.raw_output_present = true;
    input.scm_capture_requested = true;
    input.forge_change_request_requested = true;

    let record = persist_scm_capture_dry_run_execution_receipt(&state, input).expect("blocked");

    assert_eq!(
        record.persistence_status,
        ScmCaptureDryRunExecutionPersistenceStatus::Blocked
    );
    assert!(record
        .persistence_blockers
        .contains(&ScmCaptureDryRunExecutionPersistenceBlocker::RawOutputPresent));
    assert!(record
        .persistence_blockers
        .contains(&ScmCaptureDryRunExecutionPersistenceBlocker::CaptureRequested));
    assert!(!record.scm_capture_executed);
    assert!(!record.raw_material_exposed);
}

#[test]
fn scm_capture_dry_run_execution_diagnostics_source_summarizes_persisted_records() {
    let diagnostics = scm_capture_dry_run_execution_diagnostics_from_persisted_records(vec![
        persisted("accepted", ScmCaptureDryRunReceiptStatus::Accepted, false),
        persisted("completed", ScmCaptureDryRunReceiptStatus::Completed, true),
        persisted("failed", ScmCaptureDryRunReceiptStatus::Failed, false),
        persisted("timeout", ScmCaptureDryRunReceiptStatus::TimedOut, false),
        persisted("blocked", ScmCaptureDryRunReceiptStatus::Blocked, false),
        persisted(
            "repair",
            ScmCaptureDryRunReceiptStatus::RepairRequired,
            false,
        ),
    ]);

    assert_eq!(diagnostics.receipt_count, 6);
    assert_eq!(diagnostics.accepted_count, 1);
    assert_eq!(diagnostics.completed_count, 1);
    assert_eq!(diagnostics.failed_count, 1);
    assert_eq!(diagnostics.timed_out_count, 1);
    assert_eq!(diagnostics.blocked_count, 1);
    assert_eq!(diagnostics.repair_required_count, 1);
    assert_eq!(diagnostics.dry_run_executed_count, 1);
    assert!(!diagnostics.scm_capture_executed);
    assert!(!diagnostics.raw_material_exposed);
}

fn input(receipt: ScmCaptureDryRunReceiptRecord) -> ScmCaptureDryRunExecutionPersistenceInput {
    ScmCaptureDryRunExecutionPersistenceInput {
        receipt,
        existing_execution_receipt_ids: Vec::new(),
        raw_output_present: false,
        scm_capture_requested: false,
        scm_publish_requested: false,
        forge_change_request_requested: false,
        forge_merge_requested: false,
        provider_write_requested: false,
        callback_response_requested: false,
        interruption_requested: false,
        recovery_requested: false,
    }
}

fn receipt(
    id: &str,
    outcome: ScmCaptureDryRunReceiptStatus,
    scm_dry_run_executed: bool,
) -> ScmCaptureDryRunReceiptRecord {
    ScmCaptureDryRunReceiptRecord {
        receipt_id: format!("receipt:{id}"),
        capability_item_id: format!("capability:{id}"),
        admission_id: format!("admission:{id}"),
        persisted_dry_run_plan_id: format!("persisted-plan:{id}"),
        dry_run_plan_item_id: format!("dry-run-plan:{id}"),
        task_id: "task:1".to_owned(),
        work_item_id: Some("work:1".to_owned()),
        completion_id: Some("completion:1".to_owned()),
        operator_ref: "operator:tom".to_owned(),
        adapter_label: "git".to_owned(),
        workflow_label: "working-tree-preview".to_owned(),
        outcome,
        blockers: Vec::new(),
        evidence_refs: vec!["evidence:receipt".to_owned(), "evidence:receipt".to_owned()],
        changed_path_count: 2,
        summary_line_count: 4,
        scm_dry_run_executed,
        scm_capture_executed: false,
        scm_publish_executed: false,
        forge_change_request_created: false,
        forge_merge_executed: false,
        provider_write_executed: false,
        callback_response_executed: false,
        interruption_executed: false,
        recovery_executed: false,
        raw_material_exposed: false,
    }
}

fn persisted(
    id: &str,
    outcome: ScmCaptureDryRunReceiptStatus,
    scm_dry_run_executed: bool,
) -> ScmCaptureDryRunExecutionPersistenceRecord {
    ScmCaptureDryRunExecutionPersistenceRecord {
        persisted_execution_receipt_id: format!("persisted:{id}"),
        receipt_id: format!("receipt:{id}"),
        capability_item_id: format!("capability:{id}"),
        admission_id: format!("admission:{id}"),
        persisted_dry_run_plan_id: format!("persisted-plan:{id}"),
        dry_run_plan_item_id: format!("dry-run-plan:{id}"),
        task_id: "task:1".to_owned(),
        work_item_id: Some("work:1".to_owned()),
        completion_id: Some("completion:1".to_owned()),
        operator_ref: "operator:tom".to_owned(),
        adapter_label: "git".to_owned(),
        workflow_label: "working-tree-preview".to_owned(),
        outcome,
        receipt_blockers: Vec::new(),
        persistence_status: ScmCaptureDryRunExecutionPersistenceStatus::Persisted,
        persistence_blockers: Vec::new(),
        duplicate_execution_receipt_detected: false,
        evidence_refs: vec!["evidence:receipt".to_owned()],
        changed_path_count: 1,
        summary_line_count: 2,
        scm_dry_run_executed,
        scm_capture_executed: false,
        scm_publish_executed: false,
        forge_change_request_created: false,
        forge_merge_executed: false,
        provider_write_executed: false,
        callback_response_executed: false,
        interruption_executed: false,
        recovery_executed: false,
        raw_material_exposed: false,
    }
}
