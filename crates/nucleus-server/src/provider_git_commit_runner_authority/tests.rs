use super::*;
use crate::{
    GitBranchWorktreeMode, GitCommitMessageSource, GitCommitPreflightRecord, GitCommitPreflightSet,
    GitCommitPreflightStatus,
};

#[test]
fn git_commit_runner_authority_accepts_confirmed_commit_intent() {
    let set = git_commit_runner_authority(input(false));
    let authority = &set.authorities[0];

    assert_eq!(
        authority.status,
        GitCommitRunnerAuthorityStatus::ReadyForRunner
    );
    assert!(authority.runner_invocation_permitted);
    assert_eq!(
        authority.commit_message_ref,
        Some("commit-message-ref:1".to_owned())
    );
    assert_eq!(
        authority.operator_confirmation_ref,
        Some("operator-confirmation:1".to_owned())
    );
    assert!(!authority.commit_created);
    assert!(!authority.push_executed);
    assert!(!authority.raw_output_retained);
}

#[test]
fn git_commit_runner_authority_blocks_missing_intent_and_message_ref() {
    let mut input = input(false);
    input.operator_effect_intent = GitCommitRunnerOperatorEffectIntent::Missing;
    input.target_refs[0].commit_message_ref = None;

    let set = git_commit_runner_authority(input);
    let authority = &set.authorities[0];

    assert_eq!(authority.status, GitCommitRunnerAuthorityStatus::Blocked);
    assert!(!authority.runner_invocation_permitted);
    assert!(authority
        .blockers
        .contains(&GitCommitRunnerAuthorityBlocker::OperatorEffectIntentMissing));
    assert!(authority
        .blockers
        .contains(&GitCommitRunnerAuthorityBlocker::MissingCommitMessageRef));
}

#[test]
fn git_commit_runner_authority_blocks_non_ready_preflight() {
    let mut input = input(false);
    input.preflights.preflights[0].status = GitCommitPreflightStatus::Blocked;

    let set = git_commit_runner_authority(input);
    let authority = &set.authorities[0];

    assert_eq!(authority.status, GitCommitRunnerAuthorityStatus::Blocked);
    assert!(authority
        .blockers
        .contains(&GitCommitRunnerAuthorityBlocker::PreflightNotReady));
}

#[test]
fn git_commit_runner_authority_blocks_forbidden_widening() {
    let set = git_commit_runner_authority(input(true));
    let authority = &set.authorities[0];

    assert_eq!(authority.status, GitCommitRunnerAuthorityStatus::Blocked);
    assert!(authority
        .blockers
        .contains(&GitCommitRunnerAuthorityBlocker::RawOutputRetentionRequested));
    assert!(authority
        .blockers
        .contains(&GitCommitRunnerAuthorityBlocker::PushRequested));
    assert!(authority
        .blockers
        .contains(&GitCommitRunnerAuthorityBlocker::PullRequestRequested));
    assert!(authority
        .blockers
        .contains(&GitCommitRunnerAuthorityBlocker::TaskMutationRequested));
}

fn input(forbidden: bool) -> GitCommitRunnerAuthorityInput {
    GitCommitRunnerAuthorityInput {
        preflights: preflight_set(),
        operator_effect_intent: GitCommitRunnerOperatorEffectIntent::Confirmed {
            confirmation_ref: "operator-confirmation:1".to_owned(),
            allow_commit_creation: true,
        },
        target_refs: vec![GitCommitRunnerTargetRef {
            preflight_id: "preflight:1".to_owned(),
            commit_message_ref: Some("commit-message-ref:1".to_owned()),
        }],
        raw_output_retention_requested: forbidden,
        push_requested: forbidden,
        pull_request_requested: forbidden,
        forge_effect_requested: forbidden,
        provider_effect_requested: forbidden,
        callback_effect_requested: forbidden,
        interruption_effect_requested: forbidden,
        recovery_effect_requested: forbidden,
        task_mutation_requested: forbidden,
    }
}

fn preflight_set() -> GitCommitPreflightSet {
    GitCommitPreflightSet {
        preflight_set_id: "preflight-set:1".to_owned(),
        preflights: vec![preflight()],
        skipped_descriptor_ids: Vec::new(),
        shell_handoff_created: false,
        commit_created: false,
        push_executed: false,
        pull_request_created: false,
    }
}

fn preflight() -> GitCommitPreflightRecord {
    GitCommitPreflightRecord {
        preflight_id: "preflight:1".to_owned(),
        descriptor_id: "descriptor:1".to_owned(),
        admission_id: "admission:1".to_owned(),
        branch_worktree_evidence_id: "branch-worktree-evidence:1".to_owned(),
        branch_worktree_outcome_id: "branch-worktree-outcome:1".to_owned(),
        branch_worktree_handoff_id: "branch-worktree-handoff:1".to_owned(),
        branch_worktree_preflight_id: "branch-worktree-preflight:1".to_owned(),
        branch_worktree_descriptor_id: "branch-worktree-descriptor:1".to_owned(),
        branch_worktree_admission_id: "branch-worktree-admission:1".to_owned(),
        dry_run_evidence_id: "dry-run-evidence:1".to_owned(),
        dry_run_outcome_id: "dry-run-outcome:1".to_owned(),
        dry_run_handoff_id: "dry-run-handoff:1".to_owned(),
        request_id: "request:1".to_owned(),
        authority_id: "upstream-authority:1".to_owned(),
        git_plan_id: "git-plan:1".to_owned(),
        task_id: "task:1".to_owned(),
        repo_id: "repo:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        worktree_mode: GitBranchWorktreeMode::IsolatedWorktree,
        commit_message_source: Some(GitCommitMessageSource::OperatorProvided),
        status: GitCommitPreflightStatus::Ready,
        blockers: Vec::new(),
        shell_handoff_created: false,
        commit_created: false,
        push_executed: false,
        pull_request_created: false,
        forge_effect_executed: false,
        raw_output_retained: false,
    }
}
