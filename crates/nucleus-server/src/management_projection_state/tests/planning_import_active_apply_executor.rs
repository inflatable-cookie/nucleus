use super::*;

#[test]
fn planning_import_active_apply_executor_plans_stopped_receipts_without_mutation() {
    let plan = plan_planning_projection_import_active_apply_executor(executor_request("ready"));

    assert_eq!(
        plan.status,
        PlanningProjectionImportActiveApplyExecutorStatus::PlannedStopped
    );
    assert!(plan.executor_planned);
    assert_eq!(plan.operation_plans.len(), 1);
    assert_eq!(plan.planned_receipts.len(), 1);
    assert_eq!(plan.planned_receipts[0].status, "stopped_before_mutation");
    assert!(!plan.planned_receipts[0].final_mutation_receipt);
    assert!(plan.evidence_refs.contains(&"approval:accepted".to_owned()));
    assert_no_executor_effects(&plan);
}

#[test]
fn planning_import_active_apply_executor_blocks_non_admitted_records() {
    let mut request = executor_request("blocked");
    let admission = request.admission_record.as_mut().expect("admission record");
    admission.status = PlanningProjectionImportActiveApplyAdmissionStatus::Blocked;
    admission.apply_admitted = false;
    admission.blockers.push(
        PlanningProjectionImportActiveApplyAdmissionBlocker::ConflictEvidence {
            operation_id: "operation:blocked".to_owned(),
            summary: "conflict evidence".to_owned(),
        },
    );

    let plan = plan_planning_projection_import_active_apply_executor(request);

    assert_eq!(
        plan.status,
        PlanningProjectionImportActiveApplyExecutorStatus::Blocked
    );
    assert!(!plan.executor_planned);
    assert!(plan
        .blockers
        .contains(&PlanningProjectionImportActiveApplyExecutorBlocker::ApplyNotAdmitted));
    assert!(plan
        .blockers
        .contains(&PlanningProjectionImportActiveApplyExecutorBlocker::ConflictEvidence));
    assert_no_executor_effects(&plan);
}

#[test]
fn planning_import_active_apply_executor_blocks_stale_and_missing_refs() {
    let mut request = executor_request("stale");
    let operation = &mut request
        .admission_record
        .as_mut()
        .expect("admission record")
        .operation_refs[0];
    operation.observed_current_revision = Some("revision:new".to_owned());
    operation.revision_expectation_ref = None;
    operation.evidence_refs.clear();

    let plan = plan_planning_projection_import_active_apply_executor(request);

    assert_eq!(
        plan.status,
        PlanningProjectionImportActiveApplyExecutorStatus::Blocked
    );
    assert!(plan
        .blockers
        .contains(&PlanningProjectionImportActiveApplyExecutorBlocker::StaleRevision));
    assert!(plan.blockers.contains(
        &PlanningProjectionImportActiveApplyExecutorBlocker::MissingRevisionExpectation {
            operation_id: "operation:stale".to_owned()
        }
    ));
    assert!(plan.blockers.contains(
        &PlanningProjectionImportActiveApplyExecutorBlocker::MissingOperationEvidenceRef {
            operation_id: "operation:stale".to_owned()
        }
    ));
    assert_no_executor_effects(&plan);
}

#[test]
fn planning_import_active_apply_executor_preserves_duplicate_noop_without_authority() {
    let mut request = executor_request("duplicate");
    request.existing_executor_plan_ids = vec![request.executor_plan_id.clone()];

    let plan = plan_planning_projection_import_active_apply_executor(request);

    assert_eq!(
        plan.status,
        PlanningProjectionImportActiveApplyExecutorStatus::DuplicateNoop
    );
    assert!(plan.duplicate_executor_plan_detected);
    assert!(!plan.executor_planned);
    assert!(plan.blockers.iter().any(|blocker| {
        matches!(
            blocker,
            PlanningProjectionImportActiveApplyExecutorBlocker::DuplicateExecutorPlanId { .. }
        )
    }));
    assert_no_executor_effects(&plan);
}

#[test]
fn planning_import_active_apply_executor_blocks_effect_requests() {
    let mut request = executor_request("effects");
    request.active_planning_mutation_requested = true;
    request.final_mutation_receipt_requested = true;
    request.provider_execution_requested = true;
    request.scm_mutation_requested = true;

    let plan = plan_planning_projection_import_active_apply_executor(request);

    assert_eq!(
        plan.status,
        PlanningProjectionImportActiveApplyExecutorStatus::Blocked
    );
    assert!(plan.blockers.contains(
        &PlanningProjectionImportActiveApplyExecutorBlocker::ActivePlanningMutationRequested
    ));
    assert!(plan.blockers.contains(
        &PlanningProjectionImportActiveApplyExecutorBlocker::FinalMutationReceiptRequested
    ));
    assert!(plan
        .blockers
        .contains(&PlanningProjectionImportActiveApplyExecutorBlocker::ProviderExecutionRequested));
    assert!(plan
        .blockers
        .contains(&PlanningProjectionImportActiveApplyExecutorBlocker::ScmMutationRequested));
    assert_no_executor_effects(&plan);
}

fn executor_request(id: &str) -> PlanningProjectionImportActiveApplyExecutorRequest {
    PlanningProjectionImportActiveApplyExecutorRequest {
        executor_plan_id: format!("planning-import-active-apply-executor:{id}"),
        admission_record: Some(admission_record(id)),
        existing_executor_plan_ids: Vec::new(),
        evidence_refs: vec!["executor-request:reviewed".to_owned()],
        active_planning_mutation_requested: false,
        final_mutation_receipt_requested: false,
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

fn admission_record(id: &str) -> PlanningProjectionImportActiveApplyAdmissionRecord {
    PlanningProjectionImportActiveApplyAdmissionRecord {
        admission_id: format!("planning-import-active-apply-admission:{id}"),
        stopped_apply_record_id: Some(format!("planning-import-apply-plan:{id}")),
        plan_id: Some(format!("planning-import-apply-plan:{id}")),
        operator_ref: Some("operator:tom".to_owned()),
        approval_ref: Some("approval:accepted".to_owned()),
        status: PlanningProjectionImportActiveApplyAdmissionStatus::AdmittedStopped,
        blockers: Vec::new(),
        operation_refs: vec![PlanningProjectionImportActiveApplyOperationRef {
            operation_id: format!("operation:{id}"),
            readiness_entry_id: "readiness-entry:artifact".to_owned(),
            admission_record_id: "admission-record:artifact".to_owned(),
            candidate_id: "candidate:artifact".to_owned(),
            file_ref: "nucleus/planning/artifact:roadmap.toml".to_owned(),
            record_id: "record:artifact".to_owned(),
            operation_kind: "apply_planning_artifact".to_owned(),
            expected_current_revision: Some("revision:expected".to_owned()),
            observed_current_revision: Some("revision:expected".to_owned()),
            revision_expectation_ref: Some("revision:expected".to_owned()),
            evidence_refs: vec!["review:accepted".to_owned()],
        }],
        evidence_refs: vec!["approval:accepted".to_owned()],
        apply_admitted: true,
        duplicate_admission_detected: false,
        active_planning_mutation_permitted: false,
        executor_invocation_permitted: false,
        task_creation_permitted: false,
        task_promotion_permitted: false,
        projection_write_permitted: false,
        agent_scheduling_permitted: false,
        provider_execution_permitted: false,
        scm_mutation_permitted: false,
        forge_mutation_permitted: false,
        semantic_merge_permitted: false,
        accepted_memory_mutation_permitted: false,
        callback_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        raw_payload_retained: false,
        payload_body_included: false,
        ui_apply_permitted: false,
    }
}

fn assert_no_executor_effects(plan: &PlanningProjectionImportActiveApplyExecutorPlan) {
    assert!(!plan.active_planning_mutation_permitted);
    assert!(!plan.final_mutation_receipt_permitted);
    assert!(!plan.task_creation_permitted);
    assert!(!plan.task_promotion_permitted);
    assert!(!plan.projection_write_permitted);
    assert!(!plan.agent_scheduling_permitted);
    assert!(!plan.provider_execution_permitted);
    assert!(!plan.scm_mutation_permitted);
    assert!(!plan.forge_mutation_permitted);
    assert!(!plan.semantic_merge_permitted);
    assert!(!plan.accepted_memory_mutation_permitted);
    assert!(!plan.callback_permitted);
    assert!(!plan.interruption_permitted);
    assert!(!plan.recovery_permitted);
    assert!(!plan.raw_payload_retained);
    assert!(!plan.payload_body_included);
    assert!(!plan.ui_apply_permitted);
}
