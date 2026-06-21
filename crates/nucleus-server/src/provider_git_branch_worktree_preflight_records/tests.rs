use super::*;

#[test]
fn git_branch_worktree_preflight_records_require_checks() {
    let record = git_branch_worktree_preflight_records(input(
        GitBranchWorktreeMode::IsolatedWorktree,
        true,
        true,
        true,
    ));

    assert_eq!(record.preflights.len(), 2);
    assert!(record.preflights.iter().all(|preflight| {
        preflight.status == GitBranchWorktreePreflightStatus::Ready
            && !preflight.checkout_executed
            && !preflight.branch_created
            && !preflight.worktree_created
            && !preflight.shell_handoff_created
    }));
}

#[test]
fn git_branch_worktree_preflight_records_block_missing_checks() {
    let record = git_branch_worktree_preflight_records(input(
        GitBranchWorktreeMode::IsolatedWorktree,
        false,
        false,
        false,
    ));

    assert_eq!(record.preflights.len(), 2);
    assert!(record.preflights.iter().all(|preflight| {
        preflight.status == GitBranchWorktreePreflightStatus::Blocked
            && preflight
                .blockers
                .contains(&GitBranchWorktreePreflightBlocker::OperatorConfirmationMissing)
            && preflight
                .blockers
                .contains(&GitBranchWorktreePreflightBlocker::WorkingTreeNotClean)
            && preflight
                .blockers
                .contains(&GitBranchWorktreePreflightBlocker::IsolatedTargetUnavailable)
    }));
}

fn input(
    worktree_mode: GitBranchWorktreeMode,
    operator_confirmed: bool,
    working_tree_clean: bool,
    isolated_target_available: bool,
) -> GitBranchWorktreePreflightInput {
    GitBranchWorktreePreflightInput {
        descriptors: crate::git_branch_worktree_command_descriptors(
            crate::GitBranchWorktreeCommandDescriptorsInput {
                admissions: crate::git_branch_worktree_admission_records(
                    crate::GitBranchWorktreeAdmissionInput {
                        evidence: evidence(),
                        worktree_mode,
                    },
                ),
            },
        ),
        operator_confirmed,
        working_tree_clean,
        isolated_target_available,
    }
}

fn evidence() -> crate::GitChangeRequestDryRunEvidenceSet {
    let handoffs =
        crate::git_change_request_dry_run_handoff(crate::GitChangeRequestDryRunHandoffInput {
            preflights: preflights(),
        });
    let outcomes = crate::git_change_request_dry_run_sanitized_outcomes(
        crate::GitChangeRequestDryRunSanitizedOutcomesInput {
            handoffs,
            requested_status: crate::GitChangeRequestDryRunOutcomeStatus::Completed,
            changed_path_count: 3,
            insertion_count: 10,
            deletion_count: 2,
        },
    );
    crate::git_change_request_dry_run_evidence(crate::GitChangeRequestDryRunEvidenceInput {
        outcomes,
    })
}

fn preflights() -> crate::GitChangeRequestPreflightSet {
    let adapter_plans = crate::scm_change_request_adapter_plan_records(
        crate::ScmChangeRequestAdapterPlanRecordsInput {
            preparations: vec![preparation()],
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
    let requests = crate::git_change_request_command_request_records(
        crate::GitChangeRequestCommandRequestRecordsInput { descriptors },
    );
    crate::git_change_request_preflight_records(crate::GitChangeRequestPreflightRecordsInput {
        requests,
        working_tree_available: true,
        operator_confirmed: true,
        dry_run_evidence_present: true,
    })
}

fn preparation() -> crate::ScmChangeRequestPrepPersistenceRecord {
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
        adapter_label: "git".to_owned(),
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
