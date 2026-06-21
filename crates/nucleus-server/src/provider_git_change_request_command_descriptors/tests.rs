use super::*;

#[test]
fn git_change_request_command_descriptors_are_data_only() {
    let record = git_change_request_command_descriptors(input("git", true, true, false, true));

    assert_eq!(record.descriptors.len(), 3);
    assert!(record.descriptors.iter().all(|descriptor| {
        descriptor.status == GitChangeRequestCommandDescriptorStatus::Ready
            && !descriptor.shell_command_created
            && !descriptor.forge_request_created
    }));
    assert!(record.descriptors.iter().any(
        |descriptor| descriptor.command_kind == GitChangeRequestCommandKind::BranchPreparation
    ));
    assert!(record
        .descriptors
        .iter()
        .any(|descriptor| descriptor.command_kind == GitChangeRequestCommandKind::CommitCreation));
    assert!(record.descriptors.iter().any(|descriptor| {
        descriptor.command_kind == GitChangeRequestCommandKind::PullRequestCreation
    }));
    assert!(!record.shell_command_created);
    assert!(!record.forge_request_created);
}

#[test]
fn git_change_request_command_descriptors_keep_blocked_authority_visible() {
    let record =
        git_change_request_command_descriptors(input("convergence", true, false, false, false));

    assert_eq!(record.descriptors.len(), 1);
    assert_eq!(
        record.descriptors[0].status,
        GitChangeRequestCommandDescriptorStatus::Blocked
    );
    assert!(record.descriptors[0]
        .blockers
        .contains(&GitChangeRequestCommandDescriptorBlocker::AuthorityNotReady));
}

fn input(
    adapter_label: &str,
    branch: bool,
    commit: bool,
    push: bool,
    pull_request: bool,
) -> GitChangeRequestCommandDescriptorsInput {
    let adapter_plans = crate::scm_change_request_adapter_plan_records(
        crate::ScmChangeRequestAdapterPlanRecordsInput {
            preparations: vec![preparation(adapter_label)],
        },
    );
    let git_plans =
        crate::scm_change_request_git_like_plan(crate::ScmChangeRequestGitLikePlanInput {
            adapter_plans,
        });
    GitChangeRequestCommandDescriptorsInput {
        authorities: crate::git_change_request_execution_authority(
            crate::GitChangeRequestExecutionAuthorityInput {
                git_plans,
                branch_authority_requested: branch,
                commit_authority_requested: commit,
                push_authority_requested: push,
                pull_request_authority_requested: pull_request,
            },
        ),
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
