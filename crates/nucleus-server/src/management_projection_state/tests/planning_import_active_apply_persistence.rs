use super::*;

#[test]
fn planning_import_active_apply_admission_persistence_survives_reopen() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let database_path = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(database_path.clone()));

    let record = persist_planning_projection_import_active_apply_admission(
        &state,
        admission_request("ready"),
    )
    .expect("persist active apply admission");

    assert_eq!(
        record.status,
        PlanningProjectionImportActiveApplyAdmissionStatus::AdmittedStopped
    );
    assert!(record.apply_admitted);
    assert_eq!(record.operation_refs.len(), 1);
    assert_eq!(
        record.operation_refs[0].revision_expectation_ref,
        Some("revision:expected".to_owned())
    );
    assert_no_active_apply_persistence_effects(&record);

    let reopened = ServerStateService::new(SqliteBackend::new(database_path));
    let records = read_planning_projection_import_active_apply_admission_records(&reopened)
        .expect("read admission records");

    assert_eq!(records, vec![record]);
}

#[test]
fn planning_import_active_apply_admission_persistence_returns_duplicate_noop() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));

    persist_planning_projection_import_active_apply_admission(
        &state,
        admission_request("duplicate"),
    )
    .expect("first persist");
    let duplicate = persist_planning_projection_import_active_apply_admission(
        &state,
        admission_request("duplicate"),
    )
    .expect("duplicate persist");

    assert_eq!(
        duplicate.status,
        PlanningProjectionImportActiveApplyAdmissionStatus::DuplicateNoop
    );
    assert!(duplicate.duplicate_admission_detected);
    assert!(!duplicate.apply_admitted);
    assert_eq!(
        read_planning_projection_import_active_apply_admission_records(&state)
            .expect("read records")
            .len(),
        1
    );
    assert_no_active_apply_persistence_effects(&duplicate);
}

#[test]
fn planning_import_active_apply_admission_persistence_does_not_store_blocked_records() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut request = admission_request("blocked");
    request.approval_ref = None;
    request.executor_invocation_requested = true;

    let record = persist_planning_projection_import_active_apply_admission(&state, request)
        .expect("blocked record is inspectable");

    assert_eq!(
        record.status,
        PlanningProjectionImportActiveApplyAdmissionStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&PlanningProjectionImportActiveApplyAdmissionBlocker::MissingApprovalRef));
    assert!(record.blockers.contains(
        &PlanningProjectionImportActiveApplyAdmissionBlocker::ExecutorInvocationRequested
    ));
    assert!(
        read_planning_projection_import_active_apply_admission_records(&state)
            .expect("read records")
            .is_empty()
    );
    assert_no_active_apply_persistence_effects(&record);
}

#[test]
fn planning_import_active_apply_admission_persistence_rejects_raw_payload_retention() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut request = admission_request("raw");
    let stopped = request
        .stopped_apply_record
        .as_mut()
        .expect("stopped apply record");
    stopped.raw_payload_retained = true;
    stopped.payload_body_included = true;

    let record = persist_planning_projection_import_active_apply_admission(&state, request)
        .expect("raw payload record is inspectable");

    assert_eq!(
        record.status,
        PlanningProjectionImportActiveApplyAdmissionStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&PlanningProjectionImportActiveApplyAdmissionBlocker::RawPayloadPresent));
    assert!(record
        .blockers
        .contains(&PlanningProjectionImportActiveApplyAdmissionBlocker::PayloadBodyIncluded));
    assert!(
        read_planning_projection_import_active_apply_admission_records(&state)
            .expect("read records")
            .is_empty()
    );
    let serialized = serde_json::to_string(&record).expect("record json");
    for forbidden in ["private planning body", "raw projected payload"] {
        assert!(
            !serialized.contains(forbidden),
            "active apply admission leaked {forbidden}"
        );
    }
}

fn admission_request(id: &str) -> PlanningProjectionImportActiveApplyAdmissionRequest {
    let stopped_apply_record = stopped_apply_record(id);
    let operation_id = stopped_apply_record.operations[0].operation_id.clone();
    PlanningProjectionImportActiveApplyAdmissionRequest {
        admission_id: format!("admission:{id}"),
        stopped_apply_record: Some(stopped_apply_record),
        existing_admission_ids: Vec::new(),
        operator_ref: Some("operator:tom".to_owned()),
        approval_ref: Some("approval:accepted".to_owned()),
        revision_expectation_refs: vec![
            PlanningProjectionImportActiveApplyRevisionExpectationRef {
                operation_id,
                expected_current_revision: "revision:expected".to_owned(),
            },
        ],
        evidence_refs: vec!["approval:accepted".to_owned()],
        active_planning_mutation_requested: false,
        executor_invocation_requested: false,
        task_creation_requested: false,
        task_promotion_requested: false,
        projection_write_requested: false,
        agent_scheduling_requested: false,
        provider_execution_requested: false,
        scm_mutation_requested: false,
        forge_mutation_requested: false,
        semantic_merge_requested: false,
        accepted_memory_mutation_requested: false,
        callback_requested: false,
        interruption_requested: false,
        recovery_requested: false,
        ui_apply_requested: false,
    }
}

fn stopped_apply_record(id: &str) -> PlanningProjectionImportStoppedApplyRecord {
    PlanningProjectionImportStoppedApplyRecord {
        stopped_apply_record_id: format!("planning-import-apply-plan:{id}"),
        plan_id: format!("planning-import-apply-plan:{id}"),
        status: PlanningProjectionImportStoppedApplyStatus::Persisted,
        blockers: Vec::new(),
        operations: vec![PlanningProjectionImportStoppedApplyOperationRecord {
            operation_id: format!("operation:{id}"),
            readiness_entry_id: "readiness-entry:artifact".to_owned(),
            admission_record_id: "admission-record:artifact".to_owned(),
            candidate_id: "candidate:artifact".to_owned(),
            file_ref: "nucleus/planning/artifact:roadmap.toml".to_owned(),
            record_id: Some("record:artifact".to_owned()),
            expected_current_revision: Some("revision:expected".to_owned()),
            observed_current_revision: Some("revision:expected".to_owned()),
            status: "planned".to_owned(),
            operation_kind: "apply_planning_artifact".to_owned(),
            summary: "planned: apply planning artifact".to_owned(),
            evidence_refs: vec![
                "management-file-ref:nucleus/planning/artifact:roadmap.toml".to_owned(),
                "review:accepted".to_owned(),
            ],
            blocker_summaries: Vec::new(),
        }],
        planned_operation_count: 1,
        skipped_operation_count: 0,
        blocked_operation_count: 0,
        evidence_ref_count: 2,
        duplicate_plan_detected: false,
        active_planning_mutation_permitted: false,
        task_creation_permitted: false,
        task_promotion_permitted: false,
        projection_write_permitted: false,
        agent_scheduling_permitted: false,
        provider_execution_permitted: false,
        scm_mutation_permitted: false,
        forge_mutation_permitted: false,
        semantic_merge_permitted: false,
        raw_payload_retained: false,
        payload_body_included: false,
        ui_apply_permitted: false,
    }
}

fn assert_no_active_apply_persistence_effects(
    record: &PlanningProjectionImportActiveApplyAdmissionRecord,
) {
    assert!(!record.active_planning_mutation_permitted);
    assert!(!record.executor_invocation_permitted);
    assert!(!record.task_creation_permitted);
    assert!(!record.task_promotion_permitted);
    assert!(!record.projection_write_permitted);
    assert!(!record.agent_scheduling_permitted);
    assert!(!record.provider_execution_permitted);
    assert!(!record.scm_mutation_permitted);
    assert!(!record.forge_mutation_permitted);
    assert!(!record.semantic_merge_permitted);
    assert!(!record.accepted_memory_mutation_permitted);
    assert!(!record.callback_permitted);
    assert!(!record.interruption_permitted);
    assert!(!record.recovery_permitted);
    assert!(!record.raw_payload_retained);
    assert!(!record.payload_body_included);
    assert!(!record.ui_apply_permitted);
}
