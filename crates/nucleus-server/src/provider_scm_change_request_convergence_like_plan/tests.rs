use super::*;

#[test]
fn scm_change_request_convergence_like_plan_scopes_snapshot_terms() {
    let record = scm_change_request_convergence_like_plan(input("convergence"));

    assert_eq!(record.plans.len(), 1);
    assert_eq!(
        record.plans[0].status,
        ScmChangeRequestConvergenceLikePlanStatus::Ready
    );
    assert_eq!(record.plans[0].persisted_preparation_id, "prep:1");
    assert_eq!(record.plans[0].admission_id, "admission:1");
    assert_eq!(record.plans[0].evidence_refs, vec!["evidence:1"]);
    assert_eq!(
        record.plans[0].planned_snapshot_ref,
        "convergence-snapshot-plan:prep:1"
    );
    assert_eq!(
        record.plans[0].planned_publish_ref,
        "convergence-publish-plan:prep:1"
    );
}

#[test]
fn scm_change_request_convergence_like_plan_rejects_git_terms_without_effects() {
    let record = scm_change_request_convergence_like_plan(input("git"));

    assert_eq!(
        record.plans[0].status,
        ScmChangeRequestConvergenceLikePlanStatus::Unsupported
    );
    assert_eq!(record.skipped_adapter_plan_ids.len(), 1);
    assert!(record.plans[0]
        .blockers
        .contains(&ScmChangeRequestConvergenceLikePlanBlocker::NotConvergenceLikePlan));
    assert!(!record.snapshot_authority_granted);
    assert!(!record.publish_authority_granted);
    assert!(!record.provider_authority_granted);
    assert!(!record.raw_output_retained);
    assert!(!record.plans[0].snapshot_created);
    assert!(!record.plans[0].publish_executed);
}

fn input(adapter_label: &str) -> ScmChangeRequestConvergenceLikePlanInput {
    let adapter_plans = crate::scm_change_request_adapter_plan_records(
        crate::ScmChangeRequestAdapterPlanRecordsInput {
            preparations: vec![preparation(adapter_label)],
        },
    );
    ScmChangeRequestConvergenceLikePlanInput { adapter_plans }
}

fn preparation(adapter_label: &str) -> crate::ScmChangeRequestPrepPersistenceRecord {
    crate::ScmChangeRequestPrepPersistenceRecord {
        persisted_preparation_id: "prep:1".to_owned(),
        admission_id: "admission:1".to_owned(),
        decision_id: "decision:1".to_owned(),
        readiness_id: "readiness:1".to_owned(),
        workflow_id: "workflow:1".to_owned(),
        task_id: "task:1".to_owned(),
        work_item_id: Some("work:1".to_owned()),
        completion_id: Some("completion:1".to_owned()),
        repo_id: "repo:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        adapter_label: adapter_label.to_owned(),
        workflow_label: "change-request".to_owned(),
        evidence_refs: vec!["evidence:1".to_owned()],
        admission_status: crate::ScmChangeRequestPrepAdmissionStatus::Admitted,
        admission_blockers: Vec::new(),
        status: crate::ScmChangeRequestPrepPersistenceStatus::Persisted,
        blockers: Vec::new(),
        duplicate_preparation_detected: false,
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
