use super::*;

#[test]
fn git_branch_worktree_evidence_composes_reviewable_setup_evidence() {
    let record = git_branch_worktree_evidence(input(GitBranchWorktreeOutcomeStatus::Completed));

    assert_eq!(record.evidence.len(), 2);
    assert!(record.evidence.iter().all(|evidence| {
        evidence.status == GitBranchWorktreeEvidenceStatus::Reviewable
            && evidence.inspected_path_count == 4
            && evidence.affected_path_count == 1
            && evidence.worktree_mode == GitBranchWorktreeMode::IsolatedWorktree
            && !evidence.commit_readiness_granted
            && !evidence.push_readiness_granted
            && !evidence.pull_request_readiness_granted
            && !evidence.raw_output_retained
            && !evidence.git_effect_executed
            && !evidence.forge_effect_executed
    }));
}

#[test]
fn git_branch_worktree_evidence_distinguishes_failed_and_blocked_states() {
    let failed = git_branch_worktree_evidence(input(GitBranchWorktreeOutcomeStatus::Failed));
    let blocked = git_branch_worktree_evidence(blocked_input());

    assert!(failed.evidence.iter().all(|evidence| {
        evidence.status == GitBranchWorktreeEvidenceStatus::Failed
            && evidence
                .blockers
                .contains(&GitBranchWorktreeEvidenceBlocker::OutcomeNotCompleted)
    }));
    assert!(blocked.evidence.iter().all(|evidence| {
        evidence.status == GitBranchWorktreeEvidenceStatus::Blocked
            && evidence
                .blockers
                .contains(&GitBranchWorktreeEvidenceBlocker::HandoffNotAdmitted)
    }));
}

#[test]
fn git_branch_worktree_evidence_preserves_cleanup_required_without_cleanup_effect() {
    let record =
        git_branch_worktree_evidence(input(GitBranchWorktreeOutcomeStatus::CleanupRequired));

    assert_eq!(record.skipped_outcome_ids.len(), 2);
    assert!(record.evidence.iter().all(|evidence| {
        evidence.status == GitBranchWorktreeEvidenceStatus::CleanupRequired
            && evidence
                .blockers
                .contains(&GitBranchWorktreeEvidenceBlocker::CleanupRequired)
            && !evidence.git_effect_executed
            && !evidence.forge_effect_executed
    }));
}

fn input(requested_status: GitBranchWorktreeOutcomeStatus) -> GitBranchWorktreeEvidenceInput {
    GitBranchWorktreeEvidenceInput {
        outcomes: crate::git_branch_worktree_sanitized_outcomes(
            crate::GitBranchWorktreeSanitizedOutcomesInput {
                handoffs: handoffs(true, true, true),
                requested_status,
                inspected_path_count: 4,
                affected_path_count: 1,
            },
        ),
    }
}

fn blocked_input() -> GitBranchWorktreeEvidenceInput {
    GitBranchWorktreeEvidenceInput {
        outcomes: crate::git_branch_worktree_sanitized_outcomes(
            crate::GitBranchWorktreeSanitizedOutcomesInput {
                handoffs: handoffs(false, false, false),
                requested_status: GitBranchWorktreeOutcomeStatus::Completed,
                inspected_path_count: 4,
                affected_path_count: 1,
            },
        ),
    }
}

fn handoffs(
    operator_confirmed: bool,
    working_tree_clean: bool,
    isolated_target_available: bool,
) -> crate::GitBranchWorktreeExecutionHandoffSet {
    crate::git_branch_worktree_execution_handoff(crate::GitBranchWorktreeExecutionHandoffInput {
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
    })
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
