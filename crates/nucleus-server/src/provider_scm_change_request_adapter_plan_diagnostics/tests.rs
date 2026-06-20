use super::*;

#[test]
fn scm_change_request_adapter_plan_diagnostics_count_kinds_and_statuses() {
    let records = crate::scm_change_request_adapter_plan_records(
        crate::ScmChangeRequestAdapterPlanRecordsInput {
            preparations: vec![
                preparation(
                    "git",
                    crate::ScmChangeRequestPrepPersistenceStatus::Persisted,
                ),
                preparation(
                    "convergence",
                    crate::ScmChangeRequestPrepPersistenceStatus::Persisted,
                ),
                preparation(
                    "manual",
                    crate::ScmChangeRequestPrepPersistenceStatus::Persisted,
                ),
                preparation("git", crate::ScmChangeRequestPrepPersistenceStatus::Blocked),
            ],
        },
    );

    let diagnostics = scm_change_request_adapter_plan_diagnostics(records);

    assert_eq!(diagnostics.plan_count, 4);
    assert_eq!(diagnostics.ready_count, 2);
    assert_eq!(diagnostics.blocked_count, 1);
    assert_eq!(diagnostics.unsupported_count, 1);
    assert_eq!(diagnostics.git_like_count, 2);
    assert_eq!(diagnostics.convergence_like_count, 1);
    assert_eq!(diagnostics.unsupported_adapter_count, 1);
    assert_eq!(diagnostics.blocker_count, 2);
}

#[test]
fn scm_change_request_adapter_plan_diagnostics_grant_no_authority() {
    let records = crate::scm_change_request_adapter_plan_records(
        crate::ScmChangeRequestAdapterPlanRecordsInput {
            preparations: vec![preparation(
                "git",
                crate::ScmChangeRequestPrepPersistenceStatus::Persisted,
            )],
        },
    );

    let diagnostics = scm_change_request_adapter_plan_diagnostics(records);

    assert!(!diagnostics.branch_or_snapshot_authority_granted);
    assert!(!diagnostics.commit_or_publish_authority_granted);
    assert!(!diagnostics.push_or_remote_publish_authority_granted);
    assert!(!diagnostics.forge_authority_granted);
    assert!(!diagnostics.provider_authority_granted);
    assert!(!diagnostics.callback_authority_granted);
    assert!(!diagnostics.interruption_authority_granted);
    assert!(!diagnostics.recovery_authority_granted);
    assert!(!diagnostics.raw_output_retained);
}

fn preparation(
    adapter_label: &str,
    status: crate::ScmChangeRequestPrepPersistenceStatus,
) -> crate::ScmChangeRequestPrepPersistenceRecord {
    crate::ScmChangeRequestPrepPersistenceRecord {
        persisted_preparation_id: format!("prep:{adapter_label}:{status:?}"),
        admission_id: format!("admission:{adapter_label}:{status:?}"),
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
        status,
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
