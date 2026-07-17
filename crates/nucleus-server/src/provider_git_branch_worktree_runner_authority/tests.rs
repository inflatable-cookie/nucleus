use super::*;
use crate::{GitBranchWorktreeExecutionHandoffSet, GitBranchWorktreeMode};

#[test]
fn git_branch_worktree_runner_authority_accepts_confirmed_isolated_worktree() {
    let handoffs = handoffs(GitBranchWorktreeMode::IsolatedWorktree, true);
    let target_refs = target_refs(&handoffs, true);
    let record = git_branch_worktree_runner_authority(input(handoffs, target_refs));

    assert!(record.runner_invocation_permitted);
    assert_eq!(record.skipped_handoff_ids.len(), 0);
    assert!(record.authorities.iter().all(|authority| {
        authority.status == GitBranchWorktreeRunnerAuthorityStatus::ReadyForRunner
            && authority.runner_action == GitBranchWorktreeRunnerAction::CreateIsolatedWorktree
            && authority.branch_ref.as_deref() == Some("branch-ref:task")
            && authority.worktree_location_ref.as_deref() == Some("worktree-ref:task")
            && authority.runner_invocation_permitted
            && !authority.shell_execution_performed
            && !authority.commit_created
            && !authority.push_executed
            && !authority.no_effects.pull_request_created
            && !authority.no_effects.raw_output_retained
    }));
    assert!(!record.shell_execution_performed);
    assert!(!record.checkout_executed);
    assert!(!record.branch_created);
    assert!(!record.worktree_created);
    assert!(!record.commit_created);
    assert!(!record.push_executed);
    assert!(!record.no_effects.raw_output_retained);
}

#[test]
fn git_branch_worktree_runner_authority_accepts_confirmed_primary_tree() {
    let handoffs = handoffs(GitBranchWorktreeMode::PrimaryTree, true);
    let target_refs = target_refs(&handoffs, false);
    let record = git_branch_worktree_runner_authority(input(handoffs, target_refs));

    assert!(record.runner_invocation_permitted);
    assert!(record.authorities.iter().all(|authority| {
        authority.status == GitBranchWorktreeRunnerAuthorityStatus::ReadyForRunner
            && authority.runner_action == GitBranchWorktreeRunnerAction::CheckoutTemporaryBranch
            && authority.worktree_location_ref.is_none()
    }));
}

#[test]
fn git_branch_worktree_runner_authority_blocks_missing_intent_and_targets() {
    let handoffs = handoffs(GitBranchWorktreeMode::IsolatedWorktree, true);
    let mut input = input(handoffs, Vec::new());
    input.operator_effect_intent = GitBranchWorktreeRunnerOperatorEffectIntent::Missing;

    let record = git_branch_worktree_runner_authority(input);

    assert!(!record.runner_invocation_permitted);
    assert_eq!(record.skipped_handoff_ids.len(), 2);
    assert!(record.authorities.iter().all(|authority| {
        authority.status == GitBranchWorktreeRunnerAuthorityStatus::Blocked
            && authority
                .blockers
                .contains(&GitBranchWorktreeRunnerAuthorityBlocker::OperatorEffectIntentMissing)
            && authority
                .blockers
                .contains(&GitBranchWorktreeRunnerAuthorityBlocker::MissingRunnerTarget)
            && !authority.runner_invocation_permitted
            && !authority.shell_execution_performed
    }));
}

#[test]
fn git_branch_worktree_runner_authority_blocks_forbidden_widening() {
    let handoffs = handoffs(GitBranchWorktreeMode::IsolatedWorktree, true);
    let target_refs = target_refs(&handoffs, true);
    let mut input = input(handoffs, target_refs);
    input.raw_output_retention_requested = true;
    input.commit_requested = true;
    input.push_requested = true;
    input.pull_request_requested = true;
    input.forge_effect_requested = true;
    input.provider_effect_requested = true;
    input.callback_effect_requested = true;
    input.interruption_effect_requested = true;
    input.recovery_effect_requested = true;
    input.task_mutation_requested = true;

    let record = git_branch_worktree_runner_authority(input);

    assert!(!record.runner_invocation_permitted);
    let blockers = &record.authorities[0].blockers;
    assert!(
        blockers.contains(&GitBranchWorktreeRunnerAuthorityBlocker::RawOutputRetentionRequested)
    );
    assert!(blockers.contains(&GitBranchWorktreeRunnerAuthorityBlocker::CommitRequested));
    assert!(blockers.contains(&GitBranchWorktreeRunnerAuthorityBlocker::PushRequested));
    assert!(blockers.contains(&GitBranchWorktreeRunnerAuthorityBlocker::PullRequestRequested));
    assert!(blockers.contains(&GitBranchWorktreeRunnerAuthorityBlocker::ForgeEffectRequested));
    assert!(blockers.contains(&GitBranchWorktreeRunnerAuthorityBlocker::ProviderEffectRequested));
    assert!(blockers.contains(&GitBranchWorktreeRunnerAuthorityBlocker::CallbackEffectRequested));
    assert!(
        blockers.contains(&GitBranchWorktreeRunnerAuthorityBlocker::InterruptionEffectRequested)
    );
    assert!(blockers.contains(&GitBranchWorktreeRunnerAuthorityBlocker::RecoveryEffectRequested));
    assert!(blockers.contains(&GitBranchWorktreeRunnerAuthorityBlocker::TaskMutationRequested));
}

#[test]
fn git_branch_worktree_runner_authority_blocks_non_admitted_handoffs() {
    let handoffs = handoffs(GitBranchWorktreeMode::IsolatedWorktree, false);
    let target_refs = target_refs(&handoffs, true);
    let record = git_branch_worktree_runner_authority(input(handoffs, target_refs));

    assert!(!record.runner_invocation_permitted);
    assert!(record.authorities.iter().all(|authority| {
        authority
            .blockers
            .contains(&GitBranchWorktreeRunnerAuthorityBlocker::HandoffNotAdmitted)
    }));
}

fn input(
    handoffs: GitBranchWorktreeExecutionHandoffSet,
    target_refs: Vec<GitBranchWorktreeRunnerTargetRef>,
) -> GitBranchWorktreeRunnerAuthorityInput {
    GitBranchWorktreeRunnerAuthorityInput {
        handoffs,
        operator_effect_intent: GitBranchWorktreeRunnerOperatorEffectIntent::Confirmed {
            confirmation_ref: "operator-confirmation:branch-worktree-runner".to_owned(),
            allow_primary_tree_checkout: true,
            allow_isolated_worktree_creation: true,
        },
        target_refs,
        raw_output_retention_requested: false,
        commit_requested: false,
        push_requested: false,
        pull_request_requested: false,
        forge_effect_requested: false,
        provider_effect_requested: false,
        callback_effect_requested: false,
        interruption_effect_requested: false,
        recovery_effect_requested: false,
        task_mutation_requested: false,
    }
}

fn target_refs(
    handoffs: &GitBranchWorktreeExecutionHandoffSet,
    isolated: bool,
) -> Vec<GitBranchWorktreeRunnerTargetRef> {
    handoffs
        .handoffs
        .iter()
        .map(|handoff| GitBranchWorktreeRunnerTargetRef {
            handoff_id: handoff.handoff_id.clone(),
            branch_ref: Some("branch-ref:task".to_owned()),
            worktree_location_ref: isolated.then(|| "worktree-ref:task".to_owned()),
        })
        .collect()
}

fn handoffs(
    worktree_mode: GitBranchWorktreeMode,
    ready: bool,
) -> GitBranchWorktreeExecutionHandoffSet {
    crate::git_branch_worktree_execution_handoff(crate::GitBranchWorktreeExecutionHandoffInput {
        preflights: crate::git_branch_worktree_preflight_records(
            crate::GitBranchWorktreePreflightInput {
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
                operator_confirmed: ready,
                working_tree_clean: ready,
                isolated_target_available: ready,
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
