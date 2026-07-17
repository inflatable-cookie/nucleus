use super::*;

#[test]
fn git_branch_worktree_execution_diagnostics_count_records_and_modes() {
    let diagnostics =
        git_branch_worktree_execution_diagnostics(input(GitBranchWorktreeOutcomeStatus::Completed));

    assert_eq!(diagnostics.handoff_count, 2);
    assert_eq!(diagnostics.handoff_admitted_count, 2);
    assert_eq!(diagnostics.outcome_count, 2);
    assert_eq!(diagnostics.outcome_completed_count, 2);
    assert_eq!(diagnostics.evidence_count, 2);
    assert_eq!(diagnostics.evidence_reviewable_count, 2);
    assert_eq!(diagnostics.isolated_worktree_count, 2);
    assert_eq!(diagnostics.primary_tree_count, 0);
    assert_eq!(diagnostics.blocker_count, 0);
}

#[test]
fn git_branch_worktree_execution_diagnostics_count_cleanup_and_blockers() {
    let diagnostics = git_branch_worktree_execution_diagnostics(input(
        GitBranchWorktreeOutcomeStatus::CleanupRequired,
    ));

    assert_eq!(diagnostics.outcome_cleanup_required_count, 2);
    assert_eq!(diagnostics.evidence_cleanup_required_count, 2);
    assert_eq!(diagnostics.blocker_count, 2);
}

#[test]
fn git_branch_worktree_execution_diagnostics_grant_no_authority() {
    let diagnostics = git_branch_worktree_execution_diagnostics(blocked_input());

    assert_eq!(diagnostics.handoff_admitted_count, 0);
    assert_eq!(diagnostics.outcome_blocked_count, 2);
    assert_eq!(diagnostics.evidence_blocked_count, 2);
    assert!(!diagnostics.shell_execution_performed);
    assert!(!diagnostics.checkout_executed);
    assert!(!diagnostics.branch_created);
    assert!(!diagnostics.worktree_created);
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
) -> GitBranchWorktreeExecutionDiagnosticsInput {
    records(true, true, true, requested_status)
}

fn blocked_input() -> GitBranchWorktreeExecutionDiagnosticsInput {
    records(
        false,
        false,
        false,
        GitBranchWorktreeOutcomeStatus::Completed,
    )
}

fn records(
    operator_confirmed: bool,
    working_tree_clean: bool,
    isolated_target_available: bool,
    requested_status: GitBranchWorktreeOutcomeStatus,
) -> GitBranchWorktreeExecutionDiagnosticsInput {
    let handoffs = crate::git_branch_worktree_execution_handoff(
        crate::GitBranchWorktreeExecutionHandoffInput {
            preflights: crate::git_branch_worktree_preflight_records(
                crate::GitBranchWorktreePreflightInput {
                    descriptors: crate::git_branch_worktree_command_descriptors(
                        crate::GitBranchWorktreeCommandDescriptorsInput {
                            admissions: crate::git_branch_worktree_admission_records(
                                crate::GitBranchWorktreeAdmissionInput {
                                    evidence: evidence(),
                                    worktree_mode: GitBranchWorktreeMode::IsolatedWorktree,
                                },
                            ),
                        },
                    ),
                    operator_confirmed,
                    working_tree_clean,
                    isolated_target_available,
                },
            ),
        },
    );
    let outcomes = crate::git_branch_worktree_sanitized_outcomes(
        crate::GitBranchWorktreeSanitizedOutcomesInput {
            handoffs: handoffs.clone(),
            requested_status,
            inspected_path_count: 4,
            affected_path_count: 1,
        },
    );
    let evidence = crate::git_branch_worktree_evidence(crate::GitBranchWorktreeEvidenceInput {
        outcomes: outcomes.clone(),
    });

    GitBranchWorktreeExecutionDiagnosticsInput {
        handoffs,
        outcomes,
        evidence,
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
