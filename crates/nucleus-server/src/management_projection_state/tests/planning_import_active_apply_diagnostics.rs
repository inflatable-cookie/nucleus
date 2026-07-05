use super::*;

#[test]
fn planning_import_active_apply_diagnostics_counts_records_and_blockers() {
    let diagnostics = planning_projection_import_active_apply_diagnostics(vec![
        admitted_record("admitted"),
        blocked_record("blocked"),
    ]);

    assert_eq!(diagnostics.admission_record_count, 2);
    assert_eq!(diagnostics.admitted_record_count, 1);
    assert_eq!(diagnostics.blocked_record_count, 1);
    assert_eq!(diagnostics.operation_ref_count, 1);
    assert_eq!(diagnostics.stale_count, 1);
    assert_eq!(diagnostics.conflict_count, 1);
    assert_eq!(diagnostics.unsupported_count, 1);
    assert_eq!(diagnostics.repair_required_count, 1);
    assert_eq!(diagnostics.missing_ref_count, 1);
    assert!(!diagnostics.active_planning_mutation_permitted);
    assert!(!diagnostics.executor_invocation_permitted);
    assert!(!diagnostics.raw_payload_retained);
    assert!(!diagnostics.private_planning_body_exposed);
}

fn admitted_record(id: &str) -> PlanningProjectionImportActiveApplyAdmissionRecord {
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
            readiness_entry_id: "readiness:artifact".to_owned(),
            admission_record_id: "admission:artifact".to_owned(),
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

fn blocked_record(id: &str) -> PlanningProjectionImportActiveApplyAdmissionRecord {
    let mut record = admitted_record(id);
    record.status = PlanningProjectionImportActiveApplyAdmissionStatus::Blocked;
    record.apply_admitted = false;
    record.operation_refs.clear();
    record.blockers = vec![
        PlanningProjectionImportActiveApplyAdmissionBlocker::StaleRevision {
            operation_id: "operation:stale".to_owned(),
            expected_current_revision: "revision:old".to_owned(),
            observed_current_revision: "revision:new".to_owned(),
        },
        PlanningProjectionImportActiveApplyAdmissionBlocker::ConflictEvidence {
            operation_id: "operation:conflict".to_owned(),
            summary: "conflict evidence".to_owned(),
        },
        PlanningProjectionImportActiveApplyAdmissionBlocker::UnsupportedOperationKind {
            operation_id: "operation:unsupported".to_owned(),
            operation_kind: "inspect_only".to_owned(),
        },
        PlanningProjectionImportActiveApplyAdmissionBlocker::RepairRequiredEvidence {
            operation_id: "operation:repair".to_owned(),
            summary: "repair required".to_owned(),
        },
        PlanningProjectionImportActiveApplyAdmissionBlocker::MissingRevisionExpectation {
            operation_id: "operation:missing-revision".to_owned(),
        },
    ];
    record
}
