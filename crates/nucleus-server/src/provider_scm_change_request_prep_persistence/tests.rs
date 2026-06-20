use super::*;
use nucleus_local_store::SqliteBackend;

#[test]
fn scm_change_request_prep_persistence_survives_reopen() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));

    let record = persist_scm_change_request_prep(&state, input(admission())).expect("persist prep");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records = read_scm_change_request_prep_records(&reopened).expect("read prep");

    assert_eq!(records, vec![record]);
    assert_eq!(
        records[0].status,
        ScmChangeRequestPrepPersistenceStatus::Persisted
    );
    assert!(!records[0].forge_authority_granted);
    assert!(!records[0].raw_output_retained);
}

#[test]
fn scm_change_request_prep_persistence_blocks_duplicates_and_effect_requests() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let admission = admission();
    let mut duplicate = input(admission.clone());
    duplicate
        .existing_preparation_ids
        .push(persisted_preparation_id(&admission.admission_id));

    let duplicate_record =
        persist_scm_change_request_prep(&state, duplicate).expect("duplicate noop");

    assert_eq!(
        duplicate_record.status,
        ScmChangeRequestPrepPersistenceStatus::DuplicateNoop
    );
    assert!(duplicate_record.duplicate_preparation_detected);

    let mut blocked = input(admission);
    blocked.branch_or_snapshot_requested = true;
    blocked.forge_effect_requested = true;
    blocked.raw_output_present = true;
    let blocked_record = persist_scm_change_request_prep(&state, blocked).expect("blocked");

    assert_eq!(
        blocked_record.status,
        ScmChangeRequestPrepPersistenceStatus::Blocked
    );
    assert!(blocked_record
        .blockers
        .contains(&ScmChangeRequestPrepPersistenceBlocker::BranchOrSnapshotRequested));
    assert!(blocked_record
        .blockers
        .contains(&ScmChangeRequestPrepPersistenceBlocker::ForgeEffectRequested));
    assert!(!blocked_record.branch_or_snapshot_authority_granted);
    assert!(!blocked_record.forge_authority_granted);
    assert!(!blocked_record.raw_output_retained);
}

fn input(admission: ScmChangeRequestPrepAdmissionRecord) -> ScmChangeRequestPrepPersistenceInput {
    ScmChangeRequestPrepPersistenceInput {
        admission,
        existing_preparation_ids: Vec::new(),
        raw_output_present: false,
        branch_or_snapshot_requested: false,
        commit_or_publish_requested: false,
        push_or_remote_publish_requested: false,
        forge_effect_requested: false,
        provider_write_requested: false,
        callback_response_requested: false,
        interruption_requested: false,
        recovery_requested: false,
    }
}

fn admission() -> ScmChangeRequestPrepAdmissionRecord {
    ScmChangeRequestPrepAdmissionRecord {
        admission_id: "admission:1".to_owned(),
        decision_id: "decision:1".to_owned(),
        readiness_id: "readiness:1".to_owned(),
        workflow_id: "workflow:1".to_owned(),
        task_id: "task:1".to_owned(),
        work_item_id: Some("work:1".to_owned()),
        completion_id: Some("completion:1".to_owned()),
        repo_id: "repo:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        adapter_label: "adapter:scm".to_owned(),
        workflow_label: "change-request".to_owned(),
        evidence_refs: vec!["evidence:1".to_owned()],
        status: ScmChangeRequestPrepAdmissionStatus::Admitted,
        blockers: Vec::new(),
        preparation_admitted: true,
        branch_or_snapshot_authority_granted: false,
        commit_or_publish_authority_granted: false,
        push_or_remote_publish_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        raw_output_retained: false,
    }
}
