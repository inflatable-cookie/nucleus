use super::*;

#[test]
fn git_change_request_preflight_records_require_confirmation_and_dry_run() {
    let record = git_change_request_preflight_records(input("git", true, true, true));

    assert_eq!(record.preflights.len(), 2);
    assert!(record.preflights.iter().all(|preflight| {
        preflight.status == GitChangeRequestPreflightStatus::Ready
            && preflight.preflight_passed
            && !preflight.command_execution_enabled
            && !preflight.shell_command_created
            && !preflight.forge_request_created
    }));
    assert!(!record.command_execution_enabled);
}

#[test]
fn git_change_request_preflight_records_block_missing_checks() {
    let record = git_change_request_preflight_records(input("git", false, false, false));

    assert_eq!(record.preflights.len(), 2);
    assert!(record.preflights.iter().all(|preflight| {
        preflight.status == GitChangeRequestPreflightStatus::Blocked
            && preflight
                .blockers
                .contains(&GitChangeRequestPreflightBlocker::WorkingTreeUnavailable)
            && preflight
                .blockers
                .contains(&GitChangeRequestPreflightBlocker::OperatorConfirmationMissing)
            && preflight
                .blockers
                .contains(&GitChangeRequestPreflightBlocker::DryRunEvidenceMissing)
    }));
}

fn input(
    adapter_label: &str,
    working_tree_available: bool,
    operator_confirmed: bool,
    dry_run_evidence_present: bool,
) -> GitChangeRequestPreflightRecordsInput {
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
    let descriptors = crate::git_change_request_command_descriptors(
        crate::GitChangeRequestCommandDescriptorsInput { authorities },
    );
    GitChangeRequestPreflightRecordsInput {
        requests: crate::git_change_request_command_request_records(
            crate::GitChangeRequestCommandRequestRecordsInput { descriptors },
        ),
        working_tree_available,
        operator_confirmed,
        dry_run_evidence_present,
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
