use super::*;
use nucleus_local_store::SqliteBackend;

#[test]
fn live_evidence_task_state_control_persistence_round_trips_sanitized_record() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));

    let record =
        persist_live_evidence_task_state_control(&state, input(control())).expect("persist");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records = read_live_evidence_task_state_control_records(&reopened).expect("read controls");

    assert_eq!(records, vec![record]);
    assert_eq!(records[0].history_entries.len(), 1);
    assert!(!records[0].repair_required);
    assert!(!records[0].scm_mutation_permitted);
    assert!(!records[0].raw_material_retained);
}

#[test]
fn live_evidence_task_state_control_state_api_rebuilds_history_projection() {
    let record = persistence_record(
        input(control()),
        "live-evidence-task-state-control:control:1".to_owned(),
        LiveEvidenceTaskStateControlPersistenceStatus::Persisted,
        Vec::new(),
        false,
    );

    let history = live_evidence_task_state_history_from_persisted_controls(vec![record]);

    assert_eq!(history.entries.len(), 1);
    assert_eq!(history.entries[0].task_id, "task:1");
    assert!(history.skipped_admission_ids.is_empty());
    assert!(!history.scm_authority_granted);
}

#[test]
fn live_evidence_task_state_duplicate_repair_persists_blocked_as_repair_evidence() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let mut blocked = control();
    blocked.admission.status = LiveEvidenceTaskStateTransitionAdmissionStatus::Blocked;
    blocked.history.entries.clear();

    let record = persist_live_evidence_task_state_control(&state, input(blocked)).expect("persist");
    let history = live_evidence_task_state_history_from_persisted_controls(vec![record.clone()]);
    let duplicate = persist_live_evidence_task_state_control(
        &state,
        LiveEvidenceTaskStateControlPersistenceInput {
            existing_control_ids: vec![record.persisted_control_id.clone()],
            ..input(control())
        },
    )
    .expect("duplicate");

    assert_eq!(
        record.status,
        LiveEvidenceTaskStateControlPersistenceStatus::Persisted
    );
    assert!(record.repair_required);
    assert!(history.entries.is_empty());
    assert_eq!(
        history.skipped_admission_ids,
        vec!["admission:1".to_owned()]
    );
    assert_eq!(
        duplicate.status,
        LiveEvidenceTaskStateControlPersistenceStatus::DuplicateNoop
    );
    assert!(duplicate.duplicate_control_detected);
}

#[test]
fn live_evidence_task_state_duplicate_repair_blocks_raw_or_external_effect_requests() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let mut input = input(control());
    input.raw_material_present = true;
    input.scm_mutation_requested = true;
    input.provider_write_requested = true;

    let record = persist_live_evidence_task_state_control(&state, input).expect("blocked");

    assert_eq!(
        record.status,
        LiveEvidenceTaskStateControlPersistenceStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&LiveEvidenceTaskStateControlPersistenceBlocker::RawMaterialPresent));
    assert!(record
        .blockers
        .contains(&LiveEvidenceTaskStateControlPersistenceBlocker::ScmMutationRequested));
    assert!(!record.provider_write_permitted);
    assert!(!record.raw_material_retained);
}

fn input(
    control: LiveEvidenceTaskStateControlRecord,
) -> LiveEvidenceTaskStateControlPersistenceInput {
    LiveEvidenceTaskStateControlPersistenceInput {
        control,
        existing_control_ids: Vec::new(),
        raw_material_present: false,
        provider_write_requested: false,
        callback_response_requested: false,
        interruption_requested: false,
        recovery_requested: false,
        scm_mutation_requested: false,
    }
}

fn control() -> LiveEvidenceTaskStateControlRecord {
    LiveEvidenceTaskStateControlRecord {
        control_id: "control:1".to_owned(),
        request_id: "request:1".to_owned(),
        admission: crate::LiveEvidenceTaskStateTransitionAdmissionRecord {
            admission_id: "admission:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: "work:1".to_owned(),
            completion_id: "completion:1".to_owned(),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:task-state".to_owned()],
            status: LiveEvidenceTaskStateTransitionAdmissionStatus::Admitted,
            blockers: Vec::new(),
            task_state_transition_admitted: true,
            provider_authority_granted: false,
            callback_authority_granted: false,
            interruption_authority_granted: false,
            recovery_authority_granted: false,
            scm_authority_granted: false,
            raw_material_retained: false,
        },
        history: LiveEvidenceTaskStateHistoryProjectionRecord {
            projection_id: "history".to_owned(),
            entries: vec![LiveEvidenceTaskStateHistoryEntry {
                history_entry_id: "history:1".to_owned(),
                admission_id: "admission:1".to_owned(),
                task_id: "task:1".to_owned(),
                work_item_id: "work:1".to_owned(),
                completion_id: "completion:1".to_owned(),
                operator_ref: "operator:tom".to_owned(),
                evidence_refs: vec!["evidence:task-state".to_owned()],
                task_state: "completed".to_owned(),
            }],
            skipped_admission_ids: Vec::new(),
            provider_authority_granted: false,
            scm_authority_granted: false,
            raw_material_exposed: false,
        },
        task_state_mutation_requested: true,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        scm_authority_granted: false,
        raw_material_exposed: false,
    }
}
