use super::*;
use crate::GitBranchWorktreeMode;
use crate::GitBranchWorktreeOutcomeStatus;

#[test]
fn git_commit_diagnostics_count_ready_records_and_message_sources() {
    let diagnostics = git_commit_diagnostics(input(
        GitBranchWorktreeOutcomeStatus::Completed,
        Some(GitCommitMessageSource::GeneratedFromDiff),
        true,
        true,
        true,
    ));

    assert_eq!(diagnostics.admission_count, 2);
    assert_eq!(diagnostics.admission_admitted_count, 2);
    assert_eq!(diagnostics.descriptor_count, 2);
    assert_eq!(diagnostics.descriptor_ready_count, 2);
    assert_eq!(diagnostics.preflight_count, 2);
    assert_eq!(diagnostics.preflight_ready_count, 2);
    assert_eq!(diagnostics.generated_from_diff_message_count, 2);
    assert_eq!(diagnostics.blocker_count, 0);
}

#[test]
fn git_commit_diagnostics_count_blockers() {
    let diagnostics = git_commit_diagnostics(input(
        GitBranchWorktreeOutcomeStatus::Failed,
        None,
        false,
        false,
        false,
    ));

    assert_eq!(diagnostics.admission_admitted_count, 0);
    assert_eq!(diagnostics.descriptor_ready_count, 0);
    assert_eq!(diagnostics.preflight_ready_count, 0);
    assert!(diagnostics.blocker_count >= 10);
}

#[test]
fn git_commit_diagnostics_grant_no_authority() {
    let diagnostics = git_commit_diagnostics(input(
        GitBranchWorktreeOutcomeStatus::Completed,
        Some(GitCommitMessageSource::OperatorProvided),
        true,
        true,
        true,
    ));

    assert_eq!(diagnostics.operator_provided_message_count, 2);
    assert!(!diagnostics.shell_handoff_created);
    assert!(!diagnostics.commit_created);
    assert!(!diagnostics.push_executed);
    assert!(!diagnostics.no_effects.pull_request_created);
    assert!(!diagnostics.no_effects.forge_effect_executed);
    assert!(!diagnostics.no_effects.provider_effect_executed);
    assert!(!diagnostics.no_effects.callback_effect_executed);
    assert!(!diagnostics.no_effects.interruption_effect_executed);
    assert!(!diagnostics.no_effects.recovery_effect_executed);
    assert!(!diagnostics.no_effects.task_mutation_executed);
    assert!(!diagnostics.no_effects.raw_output_retained);
}

fn input(
    requested_status: GitBranchWorktreeOutcomeStatus,
    commit_message_source: Option<GitCommitMessageSource>,
    operator_confirmed: bool,
    commit_ready_changes_present: bool,
    commit_message_approved: bool,
) -> GitCommitDiagnosticsInput {
    let admissions = crate::git_commit_admission_records(crate::GitCommitAdmissionInput {
        evidence: branch_worktree_evidence(requested_status),
        commit_message_source,
    });
    let descriptors =
        crate::git_commit_command_descriptors(crate::GitCommitCommandDescriptorsInput {
            admissions: admissions.clone(),
        });
    let preflights = crate::git_commit_preflight_records(crate::GitCommitPreflightInput {
        descriptors: descriptors.clone(),
        operator_confirmed,
        commit_ready_changes_present,
        commit_message_approved,
    });

    GitCommitDiagnosticsInput {
        admissions,
        descriptors,
        preflights,
    }
}

fn branch_worktree_evidence(
    requested_status: GitBranchWorktreeOutcomeStatus,
) -> crate::GitBranchWorktreeEvidenceSet {
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
            requested_status,
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
