use super::*;
use crate::{
    GitPushPreflightRecord, GitPushPreflightSet, GitPushPreflightStatus, GitPushRemoteTarget,
};

#[test]
fn git_push_runner_authority_accepts_confirmed_push_intent() {
    let set = git_push_runner_authority(input(false));
    let authority = &set.authorities[0];

    assert_eq!(
        authority.status,
        GitPushRunnerAuthorityStatus::ReadyForRunner
    );
    assert!(authority.runner_invocation_permitted);
    assert_eq!(
        authority
            .remote_target
            .as_ref()
            .expect("remote")
            .remote_name,
        "origin"
    );
    assert_eq!(
        authority.operator_confirmation_ref,
        Some("operator-confirmation:1".to_owned())
    );
    assert!(!authority.push_executed);
    assert!(!authority.no_effects.pull_request_created);
    assert!(!authority.no_effects.raw_output_retained);
}

#[test]
fn git_push_runner_authority_blocks_missing_intent_and_remote() {
    let mut input = input(false);
    input.operator_effect_intent = GitPushRunnerOperatorEffectIntent::Missing;
    input.preflights.preflights[0].remote_target = None;

    let set = git_push_runner_authority(input);
    let authority = &set.authorities[0];

    assert_eq!(authority.status, GitPushRunnerAuthorityStatus::Blocked);
    assert!(authority
        .blockers
        .contains(&GitPushRunnerAuthorityBlocker::OperatorEffectIntentMissing));
    assert!(authority
        .blockers
        .contains(&GitPushRunnerAuthorityBlocker::MissingRemoteTarget));
}

#[test]
fn git_push_runner_authority_blocks_forbidden_widening() {
    let set = git_push_runner_authority(input(true));
    let authority = &set.authorities[0];

    assert_eq!(authority.status, GitPushRunnerAuthorityStatus::Blocked);
    assert!(authority
        .blockers
        .contains(&GitPushRunnerAuthorityBlocker::RawOutputRetentionRequested));
    assert!(authority
        .blockers
        .contains(&GitPushRunnerAuthorityBlocker::PullRequestRequested));
    assert!(authority
        .blockers
        .contains(&GitPushRunnerAuthorityBlocker::ForgeEffectRequested));
    assert!(authority
        .blockers
        .contains(&GitPushRunnerAuthorityBlocker::TaskMutationRequested));
}

fn input(forbidden: bool) -> GitPushRunnerAuthorityInput {
    GitPushRunnerAuthorityInput {
        preflights: preflight_set(),
        operator_effect_intent: GitPushRunnerOperatorEffectIntent::Confirmed {
            confirmation_ref: "operator-confirmation:1".to_owned(),
            allow_push_execution: true,
        },
        raw_output_retention_requested: forbidden,
        pull_request_requested: forbidden,
        forge_effect_requested: forbidden,
        provider_effect_requested: forbidden,
        callback_effect_requested: forbidden,
        interruption_effect_requested: forbidden,
        recovery_effect_requested: forbidden,
        task_mutation_requested: forbidden,
    }
}

fn preflight_set() -> GitPushPreflightSet {
    GitPushPreflightSet {
        preflight_set_id: "preflight-set:1".to_owned(),
        preflights: vec![preflight()],
        skipped_descriptor_ids: Vec::new(),
        shell_handoff_created: false,
        push_executed: false,
        pull_request_created: false,
    }
}

fn preflight() -> GitPushPreflightRecord {
    GitPushPreflightRecord {
        preflight_id: "preflight:1".to_owned(),
        descriptor_id: "descriptor:1".to_owned(),
        admission_id: "admission:1".to_owned(),
        commit_preflight_id: "commit-preflight:1".to_owned(),
        commit_descriptor_id: "commit-descriptor:1".to_owned(),
        commit_admission_id: "commit-admission:1".to_owned(),
        branch_worktree_evidence_id: "branch-worktree-evidence:1".to_owned(),
        request_id: "request:1".to_owned(),
        authority_id: "upstream-authority:1".to_owned(),
        git_plan_id: "git-plan:1".to_owned(),
        task_id: "task:1".to_owned(),
        repo_id: "repo:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        remote_target: Some(GitPushRemoteTarget {
            remote_name: "origin".to_owned(),
            branch_name: "feature/task".to_owned(),
        }),
        status: GitPushPreflightStatus::Ready,
        blockers: Vec::new(),
        shell_handoff_created: false,
        push_executed: false,
        pull_request_created: false,
        forge_effect_executed: false,
        raw_output_retained: false,
    }
}
