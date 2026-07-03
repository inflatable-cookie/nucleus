use super::*;
use nucleus_engine::ManagementProjectionRecordKind;

#[test]
fn planning_import_dry_run_apply_plan_builds_deterministic_planned_operations() {
    let artifact = ready_entry("artifact", "nucleus/planning/artifact:roadmap.toml");
    let task_seed = ready_entry(
        "seed",
        "nucleus/planning/task-seeds/task-seed:projection.toml",
    );

    let plan = plan_planning_projection_import_dry_run_apply(
        PlanningProjectionImportDryRunApplyPlanRequest {
            plan_id: "planning-import-apply-plan:ready".to_owned(),
            readiness: readiness_set(vec![task_seed, artifact]),
        },
    );

    assert_eq!(plan.operations.len(), 2);
    assert_eq!(plan.planned_operation_count, 2);
    assert_eq!(
        plan.operations[0].file_ref,
        "nucleus/planning/artifact:roadmap.toml"
    );
    assert_eq!(
        plan.operations[0].operation_kind,
        PlanningProjectionImportDryRunApplyOperationKind::ApplyPlanningArtifact
    );
    assert_eq!(
        plan.operations[1].operation_kind,
        PlanningProjectionImportDryRunApplyOperationKind::ApplyPlanningTaskSeed
    );
    assert!(plan.operations.iter().all(|operation| {
        operation.status == PlanningProjectionImportDryRunApplyOperationStatus::Planned
            && operation.summary.starts_with("planned:")
            && operation
                .evidence_refs
                .iter()
                .any(|evidence| evidence.starts_with("management-file-ref:nucleus/planning/"))
    }));
    assert_no_plan_effects(&plan);
    assert_no_operation_permissions(&plan.operations[0]);
}

#[test]
fn planning_import_dry_run_apply_plan_preserves_blocked_and_noop_entries() {
    let mut conflict = ready_entry("conflict", "nucleus/planning/artifact:conflict.toml");
    conflict.status = PlanningProjectionImportApplyReadinessStatus::Conflict;
    conflict.blockers.push(
        PlanningProjectionImportApplyReadinessBlocker::ConflictStaged {
            summary: "staged planning import conflict must be resolved before apply".to_owned(),
        },
    );
    let mut duplicate = ready_entry("duplicate", "nucleus/planning/artifact:duplicate.toml");
    duplicate.status = PlanningProjectionImportApplyReadinessStatus::DuplicateNoop;
    duplicate.blockers.push(
        PlanningProjectionImportApplyReadinessBlocker::DuplicateNoop {
            summary: "admission record is a duplicate no-op".to_owned(),
        },
    );

    let plan = plan_planning_projection_import_dry_run_apply(
        PlanningProjectionImportDryRunApplyPlanRequest {
            plan_id: "planning-import-apply-plan:blocked".to_owned(),
            readiness: readiness_set(vec![duplicate, conflict]),
        },
    );

    assert_eq!(plan.planned_operation_count, 0);
    assert_eq!(plan.blocked_operation_count, 1);
    assert_eq!(plan.skipped_operation_count, 1);
    assert!(plan.operations.iter().any(|operation| {
        operation.status == PlanningProjectionImportDryRunApplyOperationStatus::Blocked
            && operation.summary.starts_with("blocked:")
            && operation.blockers.iter().any(|blocker| {
                matches!(
                    blocker,
                    PlanningProjectionImportApplyReadinessBlocker::ConflictStaged { .. }
                )
            })
    }));
    assert!(plan.operations.iter().any(|operation| {
        operation.status == PlanningProjectionImportDryRunApplyOperationStatus::SkippedNoop
            && operation.summary.starts_with("skipped no-op:")
            && operation.blockers.iter().any(|blocker| {
                matches!(
                    blocker,
                    PlanningProjectionImportApplyReadinessBlocker::DuplicateNoop { .. }
                )
            })
    }));
    assert_no_plan_effects(&plan);
}

fn readiness_set(
    entries: Vec<PlanningProjectionImportApplyReadinessEntry>,
) -> PlanningProjectionImportApplyReadinessSet {
    PlanningProjectionImportApplyReadinessSet {
        readiness_id: "planning-import-readiness:test".to_owned(),
        ready_count: entries
            .iter()
            .filter(|entry| entry.status == PlanningProjectionImportApplyReadinessStatus::Ready)
            .count(),
        blocked_count: 0,
        duplicate_noop_count: 0,
        stale_count: 0,
        conflict_count: 0,
        unsupported_count: 0,
        repair_required_count: 0,
        entries,
        active_planning_mutation_performed: false,
        task_creation_performed: false,
        task_promotion_performed: false,
        agent_scheduling_performed: false,
        provider_execution_performed: false,
        scm_mutation_performed: false,
        forge_mutation_performed: false,
        semantic_merge_performed: false,
        raw_payload_retained: false,
        ui_apply_triggered: false,
    }
}

fn ready_entry(suffix: &str, file_ref: &str) -> PlanningProjectionImportApplyReadinessEntry {
    PlanningProjectionImportApplyReadinessEntry {
        readiness_entry_id: format!("readiness-entry:{suffix}"),
        admission_record_id: format!("admission-record:{suffix}"),
        candidate_id: format!("candidate:{suffix}"),
        file_ref: ManagementProjectionFileRef(file_ref.to_owned()),
        record_id: Some(ManagementProjectionRecordId(format!("record:{suffix}"))),
        expected_current_revision: None,
        observed_current_revision: None,
        status: PlanningProjectionImportApplyReadinessStatus::Ready,
        blockers: Vec::new(),
        conflict_ids: Vec::new(),
        evidence_refs: vec![
            format!("management-file-ref:{file_ref}"),
            "review:accepted".to_owned(),
            format!(
                "record-kind:{:?}",
                ManagementProjectionRecordKind::PlanningArtifact
            ),
        ],
        apply_permitted: false,
        task_promotion_permitted: false,
        provider_execution_permitted: false,
        scm_mutation_permitted: false,
        forge_mutation_permitted: false,
        ui_apply_permitted: false,
    }
}

fn assert_no_plan_effects(plan: &PlanningProjectionImportDryRunApplyPlan) {
    assert!(!plan.active_planning_mutation_performed);
    assert!(!plan.task_creation_performed);
    assert!(!plan.task_promotion_performed);
    assert!(!plan.projection_write_performed);
    assert!(!plan.agent_scheduling_performed);
    assert!(!plan.provider_execution_performed);
    assert!(!plan.scm_mutation_performed);
    assert!(!plan.forge_mutation_performed);
    assert!(!plan.semantic_merge_performed);
    assert!(!plan.raw_payload_retained);
    assert!(!plan.payload_body_included);
    assert!(!plan.ui_apply_triggered);
}

fn assert_no_operation_permissions(operation: &PlanningProjectionImportDryRunApplyOperation) {
    assert!(!operation.active_planning_mutation_permitted);
    assert!(!operation.task_creation_permitted);
    assert!(!operation.task_promotion_permitted);
    assert!(!operation.projection_write_permitted);
    assert!(!operation.agent_scheduling_permitted);
    assert!(!operation.provider_execution_permitted);
    assert!(!operation.scm_mutation_permitted);
    assert!(!operation.forge_mutation_permitted);
    assert!(!operation.ui_apply_permitted);
}
