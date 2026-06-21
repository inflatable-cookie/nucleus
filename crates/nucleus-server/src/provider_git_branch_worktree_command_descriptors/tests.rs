use super::*;

#[test]
fn git_branch_worktree_command_descriptors_keep_modes_distinct() {
    let primary =
        git_branch_worktree_command_descriptors(input(GitBranchWorktreeMode::PrimaryTree));
    let isolated =
        git_branch_worktree_command_descriptors(input(GitBranchWorktreeMode::IsolatedWorktree));

    assert_eq!(
        primary.descriptors[0].command_kind,
        GitBranchWorktreeCommandKind::CheckoutTemporaryBranch
    );
    assert_eq!(
        isolated.descriptors[0].command_kind,
        GitBranchWorktreeCommandKind::CreateIsolatedWorktree
    );
    assert!(!primary.executable_argv_created);
    assert!(!isolated.shell_handoff_created);
}

#[test]
fn git_branch_worktree_command_descriptors_block_failed_admissions() {
    let record = git_branch_worktree_command_descriptors(blocked_input());

    assert_eq!(record.descriptors.len(), 2);
    assert_eq!(record.skipped_admission_ids.len(), 2);
    assert!(record.descriptors.iter().all(|descriptor| {
        descriptor.status == GitBranchWorktreeCommandDescriptorStatus::Blocked
            && descriptor
                .blockers
                .contains(&GitBranchWorktreeCommandDescriptorBlocker::AdmissionNotAdmitted)
            && !descriptor.executable_argv_created
            && !descriptor.shell_handoff_created
    }));
}

fn input(worktree_mode: GitBranchWorktreeMode) -> GitBranchWorktreeCommandDescriptorsInput {
    GitBranchWorktreeCommandDescriptorsInput {
        admissions: crate::git_branch_worktree_admission_records(
            crate::GitBranchWorktreeAdmissionInput {
                evidence: evidence(crate::GitChangeRequestDryRunOutcomeStatus::Completed),
                worktree_mode,
            },
        ),
    }
}

fn blocked_input() -> GitBranchWorktreeCommandDescriptorsInput {
    GitBranchWorktreeCommandDescriptorsInput {
        admissions: crate::git_branch_worktree_admission_records(
            crate::GitBranchWorktreeAdmissionInput {
                evidence: evidence(crate::GitChangeRequestDryRunOutcomeStatus::Failed),
                worktree_mode: GitBranchWorktreeMode::PrimaryTree,
            },
        ),
    }
}

fn evidence(
    requested_status: crate::GitChangeRequestDryRunOutcomeStatus,
) -> crate::GitChangeRequestDryRunEvidenceSet {
    let handoffs =
        crate::git_change_request_dry_run_handoff(crate::GitChangeRequestDryRunHandoffInput {
            preflights: preflights(),
        });
    let outcomes = crate::git_change_request_dry_run_sanitized_outcomes(
        crate::GitChangeRequestDryRunSanitizedOutcomesInput {
            handoffs,
            requested_status,
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
