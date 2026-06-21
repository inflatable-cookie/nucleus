use super::*;
use crate::{
    CompletionScmCaptureAdmissionBlocker, CompletionScmCaptureAdmissionRecord,
    CompletionScmCaptureAdmissionStatus, ServerStateService,
};
use nucleus_local_store::SqliteBackend;

#[test]
fn completion_scm_capture_admission_persistence_round_trips_sanitized_record() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));

    let record =
        persist_completion_scm_capture_admission(&state, input(admission())).expect("persist");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records = read_completion_scm_capture_admissions(&reopened).expect("read");

    assert_eq!(records, vec![record]);
    assert_eq!(records[0].candidate_id, "candidate:1");
    assert!(!records[0].scm_capture_permitted);
    assert!(!records[0].raw_material_retained);
}

#[test]
fn completion_scm_capture_admission_state_api_reads_records_in_stable_order() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

    persist_completion_scm_capture_admission(&state, input(admission_with_id("b")))
        .expect("persist b");
    persist_completion_scm_capture_admission(&state, input(admission_with_id("a")))
        .expect("persist a");

    let records = read_completion_scm_capture_admissions(&state).expect("read");

    assert_eq!(records[0].admission_id, "admission:a");
    assert_eq!(records[1].admission_id, "admission:b");
}

#[test]
fn completion_scm_capture_duplicate_blocked_preserves_blocked_evidence() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let mut blocked = admission();
    blocked.status = CompletionScmCaptureAdmissionStatus::Blocked;
    blocked
        .blockers
        .push(CompletionScmCaptureAdmissionBlocker::ReadinessUnsupported);

    let record = persist_completion_scm_capture_admission(&state, input(blocked)).expect("persist");
    let duplicate = persist_completion_scm_capture_admission(
        &state,
        CompletionScmCaptureAdmissionPersistenceInput {
            existing_admission_ids: vec![record.persisted_admission_id.clone()],
            ..input(admission())
        },
    )
    .expect("duplicate");

    assert_eq!(
        record.status,
        CompletionScmCaptureAdmissionPersistenceStatus::Persisted
    );
    assert_eq!(
        record.admission_status,
        CompletionScmCaptureAdmissionStatus::Blocked
    );
    assert_eq!(
        duplicate.status,
        CompletionScmCaptureAdmissionPersistenceStatus::DuplicateNoop
    );
    assert!(duplicate.duplicate_admission_detected);
}

#[test]
fn completion_scm_capture_duplicate_blocked_blocks_raw_or_external_effect_requests() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let mut input = input(admission());
    input.raw_material_present = true;
    input.scm_capture_requested = true;
    input.forge_change_request_requested = true;

    let record = persist_completion_scm_capture_admission(&state, input).expect("blocked");

    assert_eq!(
        record.status,
        CompletionScmCaptureAdmissionPersistenceStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&CompletionScmCaptureAdmissionPersistenceBlocker::RawMaterialPresent));
    assert!(record
        .blockers
        .contains(&CompletionScmCaptureAdmissionPersistenceBlocker::ForgeChangeRequestRequested));
    assert!(!record.scm_capture_permitted);
    assert!(!record.raw_material_retained);
}

#[test]
fn completion_scm_capture_diagnostics_source_summarizes_persisted_admissions() {
    let diagnostics = completion_scm_capture_diagnostics_from_persisted_admissions(vec![
        persisted(CompletionScmCaptureAdmissionStatus::Admitted, Vec::new()),
        persisted(
            CompletionScmCaptureAdmissionStatus::Blocked,
            vec![CompletionScmCaptureAdmissionBlocker::ReadinessUnsupported],
        ),
    ]);

    assert_eq!(diagnostics.admission_count, 2);
    assert_eq!(diagnostics.admitted_count, 1);
    assert_eq!(diagnostics.blocked_count, 1);
    assert_eq!(diagnostics.blocker_count, 1);
    assert!(!diagnostics.scm_capture_executed);
}

fn input(
    admission: CompletionScmCaptureAdmissionRecord,
) -> CompletionScmCaptureAdmissionPersistenceInput {
    CompletionScmCaptureAdmissionPersistenceInput {
        admission,
        existing_admission_ids: Vec::new(),
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

fn admission() -> CompletionScmCaptureAdmissionRecord {
    admission_with_id("1")
}

fn admission_with_id(id: &str) -> CompletionScmCaptureAdmissionRecord {
    CompletionScmCaptureAdmissionRecord {
        admission_id: format!("admission:{id}"),
        request_id: format!("request:{id}"),
        readiness_id: format!("readiness:{id}"),
        candidate_id: "candidate:1".to_owned(),
        task_id: "task:1".to_owned(),
        work_item_id: Some("work:1".to_owned()),
        completion_id: Some("completion:1".to_owned()),
        operator_ref: "operator:tom".to_owned(),
        evidence_refs: vec!["evidence:capture".to_owned()],
        status: CompletionScmCaptureAdmissionStatus::Admitted,
        blockers: Vec::new(),
        capture_admitted: true,
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
    admission_status: CompletionScmCaptureAdmissionStatus,
    admission_blockers: Vec<CompletionScmCaptureAdmissionBlocker>,
) -> CompletionScmCaptureAdmissionPersistenceRecord {
    CompletionScmCaptureAdmissionPersistenceRecord {
        persisted_admission_id: "persisted:1".to_owned(),
        admission_id: "admission:1".to_owned(),
        request_id: "request:1".to_owned(),
        readiness_id: "readiness:1".to_owned(),
        candidate_id: "candidate:1".to_owned(),
        task_id: "task:1".to_owned(),
        work_item_id: Some("work:1".to_owned()),
        completion_id: Some("completion:1".to_owned()),
        operator_ref: "operator:tom".to_owned(),
        evidence_refs: vec!["evidence:capture".to_owned()],
        admission_status,
        status: CompletionScmCaptureAdmissionPersistenceStatus::Persisted,
        blockers: Vec::new(),
        admission_blockers,
        duplicate_admission_detected: false,
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
