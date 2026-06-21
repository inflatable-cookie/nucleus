use super::*;
use crate::{GitBranchWorktreeMode, GitBranchWorktreeOutcomeStatus, GitCommitMessageSource};

#[test]
fn git_push_preflight_records_require_checks() {
    let record = git_push_preflight_records(input(true, true, true));

    assert_eq!(record.preflights.len(), 2);
    assert!(record.preflights.iter().all(|preflight| {
        preflight.status == GitPushPreflightStatus::Ready
            && preflight.remote_target == Some(remote_target())
            && !preflight.shell_handoff_created
            && !preflight.push_executed
            && !preflight.pull_request_created
            && !preflight.forge_effect_executed
            && !preflight.raw_output_retained
    }));
}

#[test]
fn git_push_preflight_records_block_missing_checks() {
    let record = git_push_preflight_records(input(false, false, false));

    assert_eq!(record.skipped_descriptor_ids.len(), 2);
    assert!(record.preflights.iter().all(|preflight| {
        preflight.status == GitPushPreflightStatus::Blocked
            && preflight
                .blockers
                .contains(&GitPushPreflightBlocker::OperatorConfirmationMissing)
            && preflight
                .blockers
                .contains(&GitPushPreflightBlocker::RemoteNotReady)
            && preflight
                .blockers
                .contains(&GitPushPreflightBlocker::CredentialNotReady)
    }));
}

fn input(
    operator_confirmed: bool,
    remote_ready: bool,
    credential_ready: bool,
) -> GitPushPreflightInput {
    GitPushPreflightInput {
        descriptors: crate::git_push_command_descriptors(crate::GitPushCommandDescriptorsInput {
            admissions: crate::git_push_admission_records(crate::GitPushAdmissionInput {
                preflights: crate::git_commit_preflight_records(crate::GitCommitPreflightInput {
                    descriptors: crate::git_commit_command_descriptors(
                        crate::GitCommitCommandDescriptorsInput {
                            admissions: crate::git_commit_admission_records(
                                crate::GitCommitAdmissionInput {
                                    evidence: branch_worktree_evidence(),
                                    commit_message_source: Some(
                                        GitCommitMessageSource::AgentSuggested,
                                    ),
                                },
                            ),
                        },
                    ),
                    operator_confirmed: true,
                    commit_ready_changes_present: true,
                    commit_message_approved: true,
                }),
                remote_target: Some(remote_target()),
            }),
        }),
        operator_confirmed,
        remote_ready,
        credential_ready,
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
