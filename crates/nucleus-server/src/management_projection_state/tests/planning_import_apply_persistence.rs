use super::*;
use nucleus_local_store::SqliteBackend;

#[test]
fn planning_import_stopped_apply_persistence_survives_reopen() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let database_path = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(database_path.clone()));

    let record = persist_planning_projection_import_stopped_apply(
        &state,
        persistence_input(ready_plan("planning-import-apply-plan:ready")),
    )
    .expect("persist stopped apply");

    assert_eq!(
        record.status,
        PlanningProjectionImportStoppedApplyStatus::Persisted
    );
    assert_eq!(record.operations.len(), 1);
    assert_eq!(
        record.operations[0].expected_current_revision,
        Some("revision:expected".to_owned())
    );
    assert_no_record_effects(&record);

    let reopened = ServerStateService::new(SqliteBackend::new(database_path));
    let records =
        read_planning_projection_import_stopped_apply_records(&reopened).expect("read records");

    assert_eq!(records, vec![record]);
}

#[test]
fn planning_import_stopped_apply_persistence_returns_duplicate_noop_without_second_write() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));

    persist_planning_projection_import_stopped_apply(
        &state,
        persistence_input(ready_plan("planning-import-apply-plan:duplicate")),
    )
    .expect("first persist");
    let duplicate = persist_planning_projection_import_stopped_apply(
        &state,
        persistence_input(ready_plan("planning-import-apply-plan:duplicate")),
    )
    .expect("duplicate persist");

    assert_eq!(
        duplicate.status,
        PlanningProjectionImportStoppedApplyStatus::DuplicateNoop
    );
    assert!(duplicate.duplicate_plan_detected);
    assert_eq!(
        read_planning_projection_import_stopped_apply_records(&state)
            .expect("read records")
            .len(),
        1
    );
}

#[test]
fn planning_import_stopped_apply_persistence_rejects_blocked_and_effectful_plans() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut input = persistence_input(blocked_plan("planning-import-apply-plan:blocked"));
    input.scm_mutation_requested = true;

    let record = persist_planning_projection_import_stopped_apply(&state, input)
        .expect("blocked record is inspectable");

    assert_eq!(
        record.status,
        PlanningProjectionImportStoppedApplyStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&PlanningProjectionImportStoppedApplyBlocker::BlockedOperation));
    assert!(record
        .blockers
        .contains(&PlanningProjectionImportStoppedApplyBlocker::ScmMutationRequested));
    assert!(
        read_planning_projection_import_stopped_apply_records(&state)
            .expect("read records")
            .is_empty()
    );
}

#[test]
fn planning_import_stopped_apply_persistence_blocks_raw_payload_retention() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut input = persistence_input(ready_plan("planning-import-apply-plan:raw"));
    input.raw_payload_present = true;

    let record = persist_planning_projection_import_stopped_apply(&state, input)
        .expect("blocked raw payload record");

    assert_eq!(
        record.status,
        PlanningProjectionImportStoppedApplyStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&PlanningProjectionImportStoppedApplyBlocker::RawPayloadPresent));
    let serialized = serde_json::to_string(&record).expect("record json");
    for forbidden in ["private planning body", "raw projected payload"] {
        assert!(
            !serialized.contains(forbidden),
            "stopped apply record leaked {forbidden}"
        );
    }
}

fn persistence_input(
    plan: PlanningProjectionImportDryRunApplyPlan,
) -> PlanningProjectionImportApplyPersistenceInput {
    PlanningProjectionImportApplyPersistenceInput {
        plan,
        raw_payload_present: false,
        active_planning_mutation_requested: false,
        task_creation_requested: false,
        task_promotion_requested: false,
        projection_write_requested: false,
        agent_scheduling_requested: false,
        provider_execution_requested: false,
        scm_mutation_requested: false,
        forge_mutation_requested: false,
        semantic_merge_requested: false,
        ui_apply_requested: false,
    }
}

fn ready_plan(plan_id: &str) -> PlanningProjectionImportDryRunApplyPlan {
    PlanningProjectionImportDryRunApplyPlan {
        plan_id: plan_id.to_owned(),
        operations: vec![operation(
            plan_id,
            PlanningProjectionImportDryRunApplyOperationStatus::Planned,
        )],
        planned_operation_count: 1,
        skipped_operation_count: 0,
        blocked_operation_count: 0,
        active_planning_mutation_performed: false,
        task_creation_performed: false,
        task_promotion_performed: false,
        projection_write_performed: false,
        agent_scheduling_performed: false,
        provider_execution_performed: false,
        scm_mutation_performed: false,
        forge_mutation_performed: false,
        semantic_merge_performed: false,
        raw_payload_retained: false,
        payload_body_included: false,
        ui_apply_triggered: false,
    }
}

fn blocked_plan(plan_id: &str) -> PlanningProjectionImportDryRunApplyPlan {
    let mut plan = ready_plan(plan_id);
    plan.operations[0].status = PlanningProjectionImportDryRunApplyOperationStatus::Blocked;
    plan.operations[0].blockers.push(
        PlanningProjectionImportApplyReadinessBlocker::ConflictStaged {
            summary: "staged planning import conflict must be resolved before apply".to_owned(),
        },
    );
    plan.planned_operation_count = 0;
    plan.blocked_operation_count = 1;
    plan
}

fn operation(
    plan_id: &str,
    status: PlanningProjectionImportDryRunApplyOperationStatus,
) -> PlanningProjectionImportDryRunApplyOperation {
    PlanningProjectionImportDryRunApplyOperation {
        operation_id: format!("{plan_id}:operation:artifact"),
        readiness_entry_id: "readiness-entry:artifact".to_owned(),
        admission_record_id: "admission-record:artifact".to_owned(),
        candidate_id: "candidate:artifact".to_owned(),
        file_ref: "nucleus/planning/artifact:roadmap.toml".to_owned(),
        record_id: Some("record:artifact".to_owned()),
        expected_current_revision: Some("revision:expected".to_owned()),
        observed_current_revision: Some("revision:expected".to_owned()),
        status,
        operation_kind: PlanningProjectionImportDryRunApplyOperationKind::ApplyPlanningArtifact,
        summary: "planned: apply planning artifact from nucleus/planning/artifact:roadmap.toml"
            .to_owned(),
        evidence_refs: vec![
            "management-file-ref:nucleus/planning/artifact:roadmap.toml".to_owned(),
            "review:accepted".to_owned(),
        ],
        blockers: Vec::new(),
        active_planning_mutation_permitted: false,
        task_creation_permitted: false,
        task_promotion_permitted: false,
        projection_write_permitted: false,
        agent_scheduling_permitted: false,
        provider_execution_permitted: false,
        scm_mutation_permitted: false,
        forge_mutation_permitted: false,
        ui_apply_permitted: false,
    }
}

fn assert_no_record_effects(record: &PlanningProjectionImportStoppedApplyRecord) {
    assert!(!record.active_planning_mutation_permitted);
    assert!(!record.task_creation_permitted);
    assert!(!record.task_promotion_permitted);
    assert!(!record.projection_write_permitted);
    assert!(!record.agent_scheduling_permitted);
    assert!(!record.provider_execution_permitted);
    assert!(!record.scm_mutation_permitted);
    assert!(!record.forge_mutation_permitted);
    assert!(!record.semantic_merge_permitted);
    assert!(!record.raw_payload_retained);
    assert!(!record.payload_body_included);
    assert!(!record.ui_apply_permitted);
}
