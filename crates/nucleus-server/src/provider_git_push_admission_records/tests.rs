use super::*;
use crate::{GitBranchWorktreeMode, GitBranchWorktreeOutcomeStatus};

#[test]
fn git_push_admission_records_admit_ready_commit_preflights() {
    let record = git_push_admission_records(input(true, true, true, Some(remote_target())));

    assert_eq!(record.admissions.len(), 2);
    assert!(record.admissions.iter().all(|admission| {
        admission.status == GitPushAdmissionStatus::Admitted
            && admission.remote_target == Some(remote_target())
            && admission
                .commit_preflight_id
                .starts_with("git-commit-preflight:")
            && !admission.push_executed
            && !admission.no_effects.pull_request_created
            && !admission.no_effects.forge_effect_executed
            && !admission.no_effects.provider_effect_executed
            && !admission.no_effects.callback_effect_executed
            && !admission.no_effects.interruption_effect_executed
            && !admission.no_effects.recovery_effect_executed
            && !admission.no_effects.task_mutation_executed
            && !admission.no_effects.raw_output_retained
    }));
    assert!(!record.push_executed);
}

#[test]
fn git_push_admission_records_block_non_ready_commit_preflights() {
    let record = git_push_admission_records(input(false, false, false, Some(remote_target())));

    assert_eq!(record.skipped_preflight_ids.len(), 2);
    assert!(record.admissions.iter().all(|admission| {
        admission.status == GitPushAdmissionStatus::Blocked
            && admission
                .blockers
                .contains(&GitPushAdmissionBlocker::CommitPreflightNotReady)
            && !admission.push_executed
    }));
}

#[test]
fn git_push_admission_records_block_missing_remote_target() {
    let record = git_push_admission_records(input(true, true, true, None));

    assert_eq!(record.skipped_preflight_ids.len(), 2);
    assert!(record.admissions.iter().all(|admission| {
        admission.status == GitPushAdmissionStatus::Blocked
            && admission
                .blockers
                .contains(&GitPushAdmissionBlocker::RemoteTargetMissing)
    }));
}

fn input(
    operator_confirmed: bool,
    commit_ready_changes_present: bool,
    commit_message_approved: bool,
    remote_target: Option<GitPushRemoteTarget>,
) -> GitPushAdmissionInput {
    GitPushAdmissionInput {
        preflights: crate::git_commit_preflight_records(crate::GitCommitPreflightInput {
            descriptors: crate::git_commit_command_descriptors(
                crate::GitCommitCommandDescriptorsInput {
                    admissions: crate::git_commit_admission_records(
                        crate::GitCommitAdmissionInput {
                            evidence: branch_worktree_evidence(),
                            commit_message_source: Some(GitCommitMessageSource::AgentSuggested),
                        },
                    ),
                },
            ),
            operator_confirmed,
            commit_ready_changes_present,
            commit_message_approved,
        }),
        remote_target,
    }
}

fn remote_target() -> GitPushRemoteTarget {
    GitPushRemoteTarget {
        remote_name: "origin".to_owned(),
        branch_name: "nucleus/change-request".to_owned(),
    }
}

fn branch_worktree_evidence() -> crate::GitBranchWorktreeEvidenceSet {
    let handoffs = crate::git_branch_worktree_execution_handoff(
        crate::GitBranchWorktreeExecutionHandoffInput {
            preflights: crate::git_branch_worktree_preflight_records(
                crate::GitBranchWorktreePreflightInput {
                    descriptors: crate::git_branch_worktree_command_descriptors(
                        crate::GitBranchWorktreeCommandDescriptorsInput {
                            admissions: crate::git_branch_worktree_admission_records(
                                crate::GitBranchWorktreeAdmissionInput {
                                    evidence: dry_run_evidence(),
                                    worktree_mode: GitBranchWorktreeMode::PrimaryTree,
                                },
                            ),
                        },
                    ),
                    operator_confirmed: true,
                    working_tree_clean: true,
                    isolated_target_available: true,
                },
            ),
        },
    );
    let outcomes = crate::git_branch_worktree_sanitized_outcomes(
        crate::GitBranchWorktreeSanitizedOutcomesInput {
            handoffs,
            requested_status: GitBranchWorktreeOutcomeStatus::Completed,
            inspected_path_count: 4,
            affected_path_count: 1,
        },
    );
    crate::git_branch_worktree_evidence(crate::GitBranchWorktreeEvidenceInput { outcomes })
}

fn dry_run_evidence() -> crate::GitChangeRequestDryRunEvidenceSet {
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
