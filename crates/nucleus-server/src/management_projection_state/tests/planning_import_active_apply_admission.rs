use super::*;

#[test]
fn planning_import_active_apply_admission_accepts_persisted_stopped_apply_record() {
    let record = admit_planning_projection_import_active_apply(admission_request(
        stopped_apply_record("planning-import-apply-plan:ready"),
    ));

    assert_eq!(
        record.status,
        PlanningProjectionImportActiveApplyAdmissionStatus::AdmittedStopped
    );
    assert!(record.apply_admitted);
    assert!(record.blockers.is_empty());
    assert_eq!(record.operation_refs.len(), 1);
    assert_eq!(
        record.operation_refs[0].revision_expectation_ref,
        Some("revision:expected".to_owned())
    );
    assert!(record
        .evidence_refs
        .contains(&"management-file-ref:nucleus/planning/artifact:roadmap.toml".to_owned()));
    assert!(record
        .evidence_refs
        .contains(&"approval:accepted".to_owned()));
    assert_no_active_apply_effects(&record);
}

#[test]
fn planning_import_active_apply_admission_blocks_missing_refs_and_effect_requests() {
    let mut request = admission_request(stopped_apply_record("planning-import-apply-plan:blocked"));
    request.approval_ref = None;
    request.scm_mutation_requested = true;
    request.executor_invocation_requested = true;
    request.revision_expectation_refs.clear();

    let record = admit_planning_projection_import_active_apply(request);

    assert_eq!(
        record.status,
        PlanningProjectionImportActiveApplyAdmissionStatus::Blocked
    );
    assert!(!record.apply_admitted);
    assert!(record
        .blockers
        .contains(&PlanningProjectionImportActiveApplyAdmissionBlocker::MissingApprovalRef));
    assert!(record
        .blockers
        .contains(&PlanningProjectionImportActiveApplyAdmissionBlocker::ScmMutationRequested));
    assert!(record.blockers.contains(
        &PlanningProjectionImportActiveApplyAdmissionBlocker::ExecutorInvocationRequested
    ));
    assert!(record.blockers.contains(
        &PlanningProjectionImportActiveApplyAdmissionBlocker::MissingRevisionExpectation {
            operation_id: "operation:planning-import-apply-plan:blocked".to_owned(),
        },
    ));
    assert_no_active_apply_effects(&record);
}

#[test]
fn planning_import_active_apply_admission_blocks_stale_conflict_and_repair_evidence() {
    let mut stopped = stopped_apply_record("planning-import-apply-plan:stale");
    stopped.operations[0].observed_current_revision = Some("revision:new".to_owned());
    stopped.operations[0].blocker_summaries = vec![
        "ConflictStaged { summary: staged planning import conflict }".to_owned(),
        "RepairRequired { record_id: record:artifact }".to_owned(),
    ];

    let record = admit_planning_projection_import_active_apply(admission_request(stopped));

    assert_eq!(
        record.status,
        PlanningProjectionImportActiveApplyAdmissionStatus::Blocked
    );
    assert!(record.blockers.iter().any(|blocker| {
        matches!(
            blocker,
            PlanningProjectionImportActiveApplyAdmissionBlocker::StaleRevision { .. }
        )
    }));
    assert!(record.blockers.iter().any(|blocker| {
        matches!(
            blocker,
            PlanningProjectionImportActiveApplyAdmissionBlocker::ConflictEvidence { .. }
        )
    }));
    assert!(record.blockers.iter().any(|blocker| {
        matches!(
            blocker,
            PlanningProjectionImportActiveApplyAdmissionBlocker::RepairRequiredEvidence { .. }
        )
    }));
    assert_no_active_apply_effects(&record);
}

#[test]
fn planning_import_active_apply_admission_preserves_duplicate_noop_without_authority() {
    let mut request =
        admission_request(stopped_apply_record("planning-import-apply-plan:duplicate"));
    request.existing_admission_ids = vec![request.admission_id.clone()];

    let record = admit_planning_projection_import_active_apply(request);

    assert_eq!(
        record.status,
        PlanningProjectionImportActiveApplyAdmissionStatus::DuplicateNoop
    );
    assert!(record.duplicate_admission_detected);
    assert!(!record.apply_admitted);
    assert!(record.blockers.iter().any(|blocker| {
        matches!(
            blocker,
            PlanningProjectionImportActiveApplyAdmissionBlocker::DuplicateAdmissionId { .. }
        )
    }));
    assert_no_active_apply_effects(&record);
}

#[test]
fn planning_import_active_apply_admission_blocks_non_persisted_stopped_apply_record() {
    let mut stopped = stopped_apply_record("planning-import-apply-plan:stopped-blocked");
    stopped.status = PlanningProjectionImportStoppedApplyStatus::Blocked;
    stopped.blockers = vec![PlanningProjectionImportStoppedApplyBlocker::RawPayloadPresent];
    stopped.raw_payload_retained = true;

    let record = admit_planning_projection_import_active_apply(admission_request(stopped));

    assert_eq!(
        record.status,
        PlanningProjectionImportActiveApplyAdmissionStatus::Blocked
    );
    assert!(record.blockers.iter().any(|blocker| {
        matches!(
            blocker,
            PlanningProjectionImportActiveApplyAdmissionBlocker::StoppedApplyBlocked { .. }
        )
    }));
    assert!(record
        .blockers
        .contains(&PlanningProjectionImportActiveApplyAdmissionBlocker::RawPayloadPresent));
    assert_no_active_apply_effects(&record);
}

fn admission_request(
    stopped_apply_record: PlanningProjectionImportStoppedApplyRecord,
) -> PlanningProjectionImportActiveApplyAdmissionRequest {
    PlanningProjectionImportActiveApplyAdmissionRequest {
        admission_id: format!(
            "active-apply-admission:{}",
            stopped_apply_record.stopped_apply_record_id
        ),
        stopped_apply_record: Some(stopped_apply_record),
        existing_admission_ids: Vec::new(),
        operator_ref: Some("operator:tom".to_owned()),
        approval_ref: Some("approval:accepted".to_owned()),
        revision_expectation_refs: vec![
            PlanningProjectionImportActiveApplyRevisionExpectationRef {
                operation_id: "operation:planning-import-apply-plan:ready".to_owned(),
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

fn stopped_apply_record(plan_id: &str) -> PlanningProjectionImportStoppedApplyRecord {
    let operation_id = format!("operation:{plan_id}");
    PlanningProjectionImportStoppedApplyRecord {
        stopped_apply_record_id: format!("planning-import-apply-plan:{plan_id}"),
        plan_id: plan_id.to_owned(),
        status: PlanningProjectionImportStoppedApplyStatus::Persisted,
        blockers: Vec::new(),
        operations: vec![PlanningProjectionImportStoppedApplyOperationRecord {
            operation_id,
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

fn assert_no_active_apply_effects(record: &PlanningProjectionImportActiveApplyAdmissionRecord) {
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
