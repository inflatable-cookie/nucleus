use super::*;

#[test]
fn git_change_request_execution_authority_splits_git_gates() {
    let record = git_change_request_execution_authority(input("git", true, true, true, true));

    assert_eq!(record.authorities.len(), 1);
    assert_eq!(
        record.authorities[0].status,
        GitChangeRequestExecutionAuthorityStatus::Ready
    );
    assert_eq!(record.authorities[0].git_plan_id, git_plan_id("prep:1"));
    assert!(record.authorities[0].branch_authority_requested);
    assert!(record.authorities[0].commit_authority_requested);
    assert!(record.authorities[0].push_authority_requested);
    assert!(record.authorities[0].pull_request_authority_requested);
    assert!(!record.authorities[0].branch_authority_granted);
    assert!(!record.authorities[0].commit_authority_granted);
    assert!(!record.authorities[0].push_authority_granted);
    assert!(!record.authorities[0].pull_request_authority_granted);
}

#[test]
fn git_change_request_execution_authority_rejects_non_ready_git_plans() {
    let record =
        git_change_request_execution_authority(input("convergence", true, false, false, false));

    assert_eq!(record.skipped_git_plan_ids, vec![git_plan_id("prep:1")]);
    assert_eq!(
        record.authorities[0].status,
        GitChangeRequestExecutionAuthorityStatus::Blocked
    );
    assert!(record.authorities[0]
        .blockers
        .contains(&GitChangeRequestExecutionAuthorityBlocker::GitPlanNotReady));
}

#[test]
fn git_change_request_execution_authority_requires_requested_gate() {
    let record = git_change_request_execution_authority(input("git", false, false, false, false));

    assert_eq!(
        record.authorities[0].status,
        GitChangeRequestExecutionAuthorityStatus::Blocked
    );
    assert!(record.authorities[0]
        .blockers
        .contains(&GitChangeRequestExecutionAuthorityBlocker::NoAuthorityRequested));
}

#[test]
fn git_change_request_execution_authority_executes_no_effects() {
    let record = git_change_request_execution_authority(input("git", true, true, true, true));

    assert!(!record.branch_authority_granted);
    assert!(!record.commit_authority_granted);
    assert!(!record.push_authority_granted);
    assert!(!record.pull_request_authority_granted);
    assert!(!record.forge_authority_granted);
    assert!(!record.provider_authority_granted);
    assert!(!record.callback_authority_granted);
    assert!(!record.interruption_authority_granted);
    assert!(!record.recovery_authority_granted);
    assert!(!record.raw_output_retained);
    assert!(!record.authorities[0].branch_created);
    assert!(!record.authorities[0].commit_created);
    assert!(!record.authorities[0].push_executed);
    assert!(!record.authorities[0].pull_request_created);
}

fn input(
    adapter_label: &str,
    branch_authority_requested: bool,
    commit_authority_requested: bool,
    push_authority_requested: bool,
    pull_request_authority_requested: bool,
) -> GitChangeRequestExecutionAuthorityInput {
    let adapter_plans = crate::scm_change_request_adapter_plan_records(
        crate::ScmChangeRequestAdapterPlanRecordsInput {
            preparations: vec![preparation(adapter_label)],
        },
    );
    let git_plans =
        crate::scm_change_request_git_like_plan(crate::ScmChangeRequestGitLikePlanInput {
            adapter_plans,
        });
    GitChangeRequestExecutionAuthorityInput {
        git_plans,
        branch_authority_requested,
        commit_authority_requested,
        push_authority_requested,
        pull_request_authority_requested,
    }
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

fn git_plan_id(persisted_preparation_id: &str) -> String {
    format!(
        "scm-change-request-git-like-plan:scm-change-request-adapter-plan:{persisted_preparation_id}"
    )
}
