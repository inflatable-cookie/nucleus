use super::*;

#[test]
fn scm_change_request_adapter_plan_records_reference_persisted_preparations() {
    let record = scm_change_request_adapter_plan_records(input(vec![preparation("git")]));

    assert_eq!(record.plans.len(), 1);
    assert_eq!(record.plans[0].persisted_preparation_id, "prep:1");
    assert_eq!(record.plans[0].admission_id, "admission:1");
    assert_eq!(record.plans[0].workflow_id, "workflow:1");
    assert_eq!(
        record.plans[0].plan_kind,
        ScmChangeRequestAdapterPlanKind::GitBranchChangeRequest
    );
    assert_eq!(
        record.plans[0].status,
        ScmChangeRequestAdapterPlanStatus::Ready
    );
}

#[test]
fn scm_change_request_adapter_plan_records_allow_snapshot_publish_plans() {
    let record = scm_change_request_adapter_plan_records(input(vec![preparation("convergence")]));

    assert_eq!(
        record.plans[0].plan_kind,
        ScmChangeRequestAdapterPlanKind::SnapshotPublishChangeRequest
    );
    assert_eq!(
        record.plans[0].status,
        ScmChangeRequestAdapterPlanStatus::Ready
    );
}

#[test]
fn scm_change_request_adapter_plan_records_keep_unsupported_adapters_visible() {
    let record = scm_change_request_adapter_plan_records(input(vec![preparation("manual")]));

    assert_eq!(record.unsupported_preparation_ids, vec!["prep:1"]);
    assert_eq!(
        record.plans[0].plan_kind,
        ScmChangeRequestAdapterPlanKind::UnsupportedAdapter
    );
    assert_eq!(
        record.plans[0].status,
        ScmChangeRequestAdapterPlanStatus::Unsupported
    );
    assert!(record.plans[0]
        .blockers
        .contains(&ScmChangeRequestAdapterPlanBlocker::UnsupportedAdapter));
}

#[test]
fn scm_change_request_adapter_plan_records_do_not_grant_authority() {
    let mut preparation = preparation("git");
    preparation.branch_or_snapshot_authority_granted = true;
    preparation.commit_or_publish_authority_granted = true;
    preparation.push_or_remote_publish_authority_granted = true;
    preparation.forge_authority_granted = true;
    preparation.provider_authority_granted = true;
    preparation.callback_authority_granted = true;
    preparation.interruption_authority_granted = true;
    preparation.recovery_authority_granted = true;
    preparation.raw_output_retained = true;

    let record = scm_change_request_adapter_plan_records(input(vec![preparation]));

    assert_eq!(record.blocked_preparation_ids, vec!["prep:1"]);
    assert_eq!(
        record.plans[0].status,
        ScmChangeRequestAdapterPlanStatus::Blocked
    );
    assert!(!record.branch_or_snapshot_authority_granted);
    assert!(!record.commit_or_publish_authority_granted);
    assert!(!record.push_or_remote_publish_authority_granted);
    assert!(!record.forge_authority_granted);
    assert!(!record.provider_authority_granted);
    assert!(!record.callback_authority_granted);
    assert!(!record.interruption_authority_granted);
    assert!(!record.recovery_authority_granted);
    assert!(!record.raw_output_retained);
    assert!(!record.plans[0].branch_or_snapshot_authority_granted);
    assert!(!record.plans[0].commit_or_publish_authority_granted);
    assert!(!record.plans[0].push_or_remote_publish_authority_granted);
    assert!(!record.plans[0].forge_authority_granted);
    assert!(!record.plans[0].provider_authority_granted);
    assert!(!record.plans[0].callback_authority_granted);
    assert!(!record.plans[0].interruption_authority_granted);
    assert!(!record.plans[0].recovery_authority_granted);
    assert!(!record.plans[0].raw_output_retained);
}

fn input(
    preparations: Vec<ScmChangeRequestPrepPersistenceRecord>,
) -> ScmChangeRequestAdapterPlanRecordsInput {
    ScmChangeRequestAdapterPlanRecordsInput { preparations }
}

fn preparation(adapter_label: &str) -> ScmChangeRequestPrepPersistenceRecord {
    ScmChangeRequestPrepPersistenceRecord {
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
        evidence_refs: vec!["evidence:2".to_owned(), "evidence:1".to_owned()],
        admission_status: crate::ScmChangeRequestPrepAdmissionStatus::Admitted,
        admission_blockers: Vec::new(),
        status: ScmChangeRequestPrepPersistenceStatus::Persisted,
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
