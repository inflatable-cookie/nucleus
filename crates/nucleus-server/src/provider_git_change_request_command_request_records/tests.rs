use super::*;

#[test]
fn git_change_request_command_request_records_are_stopped_by_default() {
    let record = git_change_request_command_request_records(input("git"));

    assert_eq!(record.requests.len(), 2);
    assert!(record.requests.iter().all(|request| {
        request.status == GitChangeRequestCommandRequestStatus::Admitted
            && request.idempotency_key.starts_with("idempotency:")
            && !request.command_execution_enabled
            && !request.shell_command_created
            && !request.forge_request_created
    }));
    assert!(!record.command_execution_enabled);
    assert!(!record.shell_command_created);
    assert!(!record.forge_request_created);
}

#[test]
fn git_change_request_command_request_records_block_non_ready_descriptors() {
    let record = git_change_request_command_request_records(input("convergence"));

    assert_eq!(record.requests.len(), 2);
    assert!(record.requests.iter().all(|request| {
        request.status == GitChangeRequestCommandRequestStatus::Blocked
            && request
                .blockers
                .contains(&GitChangeRequestCommandRequestBlocker::DescriptorNotReady)
    }));
    assert_eq!(record.skipped_descriptor_ids.len(), 2);
}

fn input(adapter_label: &str) -> GitChangeRequestCommandRequestRecordsInput {
    let adapter_plans = crate::scm_change_request_adapter_plan_records(
        crate::ScmChangeRequestAdapterPlanRecordsInput {
            preparations: vec![preparation(adapter_label)],
        },
    );
    let git_plans =
        crate::scm_change_request_git_like_plan(crate::ScmChangeRequestGitLikePlanInput {
            adapter_plans,
        });
    let authorities = crate::git_change_request_execution_authority(
        crate::GitChangeRequestExecutionAuthorityInput {
            git_plans,
            branch_authority_requested: true,
            commit_authority_requested: true,
            push_authority_requested: false,
            pull_request_authority_requested: false,
        },
    );
    GitChangeRequestCommandRequestRecordsInput {
        descriptors: crate::git_change_request_command_descriptors(
            crate::GitChangeRequestCommandDescriptorsInput { authorities },
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
