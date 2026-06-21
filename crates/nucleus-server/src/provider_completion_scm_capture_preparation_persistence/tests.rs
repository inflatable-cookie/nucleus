use super::*;
use crate::{
    CompletionScmCapturePlanBlocker, CompletionScmCapturePlanItem, CompletionScmCapturePlanStatus,
};
use nucleus_local_store::SqliteBackend;

#[test]
fn completion_scm_capture_preparation_persistence_round_trips_sanitized_record() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));

    let record = persist_completion_scm_capture_preparation(&state, input(plan("1", ready())))
        .expect("persist");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records = read_completion_scm_capture_preparations(&reopened).expect("read");

    assert_eq!(records, vec![record]);
    assert_eq!(records[0].adapter_label, "adapter");
    assert!(!records[0].scm_capture_permitted);
    assert!(!records[0].raw_material_retained);
}

#[test]
fn completion_scm_capture_preparation_state_api_reads_records_in_stable_order() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

    persist_completion_scm_capture_preparation(&state, input(plan("b", ready())))
        .expect("persist b");
    persist_completion_scm_capture_preparation(&state, input(plan("a", ready())))
        .expect("persist a");

    let records = read_completion_scm_capture_preparations(&state).expect("read");

    assert_eq!(records[0].plan_item_id, "plan:a");
    assert_eq!(records[1].plan_item_id, "plan:b");
}

#[test]
fn completion_scm_capture_preparation_duplicate_repair_preserves_non_ready_states() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

    let unsupported = persist_completion_scm_capture_preparation(
        &state,
        input(plan("unsupported", unsupported())),
    )
    .expect("persist unsupported");
    let repair =
        persist_completion_scm_capture_preparation(&state, input(plan("repair", repair())))
            .expect("persist repair");
    let duplicate = persist_completion_scm_capture_preparation(
        &state,
        CompletionScmCapturePreparationPersistenceInput {
            existing_preparation_ids: vec![unsupported.persisted_preparation_id.clone()],
            ..input(plan("unsupported", ready()))
        },
    )
    .expect("duplicate");

    assert_eq!(
        unsupported.plan_status,
        CompletionScmCapturePlanStatus::Unsupported
    );
    assert_eq!(
        repair.plan_status,
        CompletionScmCapturePlanStatus::RepairRequired
    );
    assert_eq!(
        duplicate.status,
        CompletionScmCapturePreparationPersistenceStatus::DuplicateNoop
    );
    assert!(duplicate.duplicate_preparation_detected);
}

#[test]
fn completion_scm_capture_preparation_duplicate_repair_blocks_raw_or_external_requests() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let mut input = input(plan("blocked", ready()));
    input.raw_material_present = true;
    input.scm_capture_requested = true;
    input.forge_change_request_requested = true;

    let record = persist_completion_scm_capture_preparation(&state, input).expect("blocked");

    assert_eq!(
        record.status,
        CompletionScmCapturePreparationPersistenceStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&CompletionScmCapturePreparationPersistenceBlocker::RawMaterialPresent));
    assert!(record
        .blockers
        .contains(&CompletionScmCapturePreparationPersistenceBlocker::ForgeChangeRequestRequested));
    assert!(!record.scm_capture_permitted);
    assert!(!record.raw_material_retained);
}

#[test]
fn completion_scm_capture_preparation_diagnostics_source_summarizes_persisted_records() {
    let diagnostics = completion_scm_capture_preparation_diagnostics_from_persisted_records(vec![
        persisted("ready", CompletionScmCapturePlanStatus::Ready, Vec::new()),
        persisted(
            "unsupported",
            CompletionScmCapturePlanStatus::Unsupported,
            vec![CompletionScmCapturePlanBlocker::CaptureUnsupported],
        ),
        persisted(
            "repair",
            CompletionScmCapturePlanStatus::RepairRequired,
            vec![CompletionScmCapturePlanBlocker::AdapterUnavailable],
        ),
    ]);

    assert_eq!(diagnostics.candidate_count, 3);
    assert_eq!(diagnostics.plan_count, 3);
    assert_eq!(diagnostics.ready_plan_count, 1);
    assert_eq!(diagnostics.unsupported_plan_count, 1);
    assert_eq!(diagnostics.repair_required_plan_count, 1);
    assert_eq!(diagnostics.blocker_count, 2);
    assert!(!diagnostics.scm_capture_authority_granted);
}

fn input(
    plan_item: CompletionScmCapturePlanItem,
) -> CompletionScmCapturePreparationPersistenceInput {
    CompletionScmCapturePreparationPersistenceInput {
        plan_item,
        admission_id: "admission:1".to_owned(),
        readiness_id: "readiness:1".to_owned(),
        capture_candidate_id: "candidate:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        evidence_refs: vec!["evidence:prep".to_owned()],
        existing_preparation_ids: Vec::new(),
        raw_material_present: false,
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

fn plan(id: &str, status: CompletionScmCapturePlanStatus) -> CompletionScmCapturePlanItem {
    CompletionScmCapturePlanItem {
        plan_item_id: format!("plan:{id}"),
        preparation_candidate_id: format!("prep:{id}"),
        task_id: "task:1".to_owned(),
        work_item_id: Some("work:1".to_owned()),
        completion_id: Some("completion:1".to_owned()),
        adapter_label: "adapter".to_owned(),
        workflow_label: "workflow".to_owned(),
        status: status.clone(),
        blockers: match status {
            CompletionScmCapturePlanStatus::Ready => Vec::new(),
            CompletionScmCapturePlanStatus::Unsupported => {
                vec![CompletionScmCapturePlanBlocker::CaptureUnsupported]
            }
            CompletionScmCapturePlanStatus::RepairRequired => {
                vec![CompletionScmCapturePlanBlocker::AdapterUnavailable]
            }
        },
    }
}

fn ready() -> CompletionScmCapturePlanStatus {
    CompletionScmCapturePlanStatus::Ready
}

fn unsupported() -> CompletionScmCapturePlanStatus {
    CompletionScmCapturePlanStatus::Unsupported
}

fn repair() -> CompletionScmCapturePlanStatus {
    CompletionScmCapturePlanStatus::RepairRequired
}

fn persisted(
    id: &str,
    plan_status: CompletionScmCapturePlanStatus,
    plan_blockers: Vec<CompletionScmCapturePlanBlocker>,
) -> CompletionScmCapturePreparationPersistenceRecord {
    CompletionScmCapturePreparationPersistenceRecord {
        persisted_preparation_id: format!("persisted:{id}"),
        plan_item_id: format!("plan:{id}"),
        preparation_candidate_id: format!("prep:{id}"),
        admission_id: "admission:1".to_owned(),
        readiness_id: "readiness:1".to_owned(),
        capture_candidate_id: "candidate:1".to_owned(),
        task_id: "task:1".to_owned(),
        work_item_id: Some("work:1".to_owned()),
        completion_id: Some("completion:1".to_owned()),
        operator_ref: "operator:tom".to_owned(),
        evidence_refs: vec!["evidence:prep".to_owned()],
        adapter_label: "adapter".to_owned(),
        workflow_label: "workflow".to_owned(),
        plan_status,
        plan_blockers,
        status: CompletionScmCapturePreparationPersistenceStatus::Persisted,
        blockers: Vec::new(),
        duplicate_preparation_detected: false,
        scm_capture_permitted: false,
        scm_publish_permitted: false,
        forge_change_request_permitted: false,
        forge_merge_permitted: false,
        provider_write_permitted: false,
        callback_response_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        raw_material_retained: false,
    }
}
