use super::*;
use crate::{
    ForgePullRequestExecutionPreflightRecord, ForgePullRequestExecutionPreflightSet,
    ForgePullRequestExecutionPreflightStatus, ForgePullRequestProvider, ForgePullRequestTextSource,
};

#[test]
fn forge_pull_request_runner_authority_accepts_request_preparation() {
    let set = forge_pull_request_runner_authority(input(false));
    let authority = &set.authorities[0];

    assert_eq!(
        authority.status,
        ForgePullRequestRunnerAuthorityStatus::ReadyForRequest
    );
    assert!(authority.request_preparation_permitted);
    assert_eq!(
        authority.forge_provider,
        Some(ForgePullRequestProvider::GitHub)
    );
    assert!(!authority.pull_request_created);
    assert!(!authority.provider_effect_executed);
    assert!(!authority.raw_output_retained);
}

#[test]
fn forge_pull_request_runner_authority_blocks_missing_intent_and_refs() {
    let mut input = input(false);
    input.operator_effect_intent = ForgePullRequestRunnerOperatorEffectIntent::Missing;
    input.preflights.preflights[0].forge_provider = None;
    input.preflights.preflights[0].base_branch = None;

    let set = forge_pull_request_runner_authority(input);
    let authority = &set.authorities[0];

    assert_eq!(
        authority.status,
        ForgePullRequestRunnerAuthorityStatus::Blocked
    );
    assert!(authority
        .blockers
        .contains(&ForgePullRequestRunnerAuthorityBlocker::OperatorEffectIntentMissing));
    assert!(authority
        .blockers
        .contains(&ForgePullRequestRunnerAuthorityBlocker::MissingForgeProvider));
    assert!(authority
        .blockers
        .contains(&ForgePullRequestRunnerAuthorityBlocker::MissingBaseBranch));
}

#[test]
fn forge_pull_request_runner_authority_blocks_provider_widening() {
    let set = forge_pull_request_runner_authority(input(true));
    let authority = &set.authorities[0];

    assert_eq!(
        authority.status,
        ForgePullRequestRunnerAuthorityStatus::Blocked
    );
    assert!(authority
        .blockers
        .contains(&ForgePullRequestRunnerAuthorityBlocker::PullRequestCreationRequested));
    assert!(authority
        .blockers
        .contains(&ForgePullRequestRunnerAuthorityBlocker::ProviderEffectRequested));
    assert!(authority
        .blockers
        .contains(&ForgePullRequestRunnerAuthorityBlocker::RawOutputRetentionRequested));
}

fn input(forbidden: bool) -> ForgePullRequestRunnerAuthorityInput {
    ForgePullRequestRunnerAuthorityInput {
        preflights: preflight_set(),
        operator_effect_intent: ForgePullRequestRunnerOperatorEffectIntent::Confirmed {
            confirmation_ref: "operator-confirmation:1".to_owned(),
            allow_request_preparation: true,
        },
        raw_output_retention_requested: forbidden,
        pull_request_creation_requested: forbidden,
        forge_effect_requested: forbidden,
        provider_effect_requested: forbidden,
        callback_effect_requested: forbidden,
        interruption_effect_requested: forbidden,
        recovery_effect_requested: forbidden,
        task_mutation_requested: forbidden,
    }
}

fn preflight_set() -> ForgePullRequestExecutionPreflightSet {
    ForgePullRequestExecutionPreflightSet {
        preflight_set_id: "preflight-set:1".to_owned(),
        preflights: vec![preflight()],
        skipped_admission_ids: Vec::new(),
        pull_request_created: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        raw_output_retained: false,
    }
}

fn preflight() -> ForgePullRequestExecutionPreflightRecord {
    ForgePullRequestExecutionPreflightRecord {
        preflight_id: "preflight:1".to_owned(),
        admission_id: "admission:1".to_owned(),
        pr_evidence_id: "pr-evidence:1".to_owned(),
        pr_descriptor_id: "pr-descriptor:1".to_owned(),
        push_preflight_id: "push-preflight:1".to_owned(),
        request_id: "request:1".to_owned(),
        authority_id: "upstream-authority:1".to_owned(),
        git_plan_id: "git-plan:1".to_owned(),
        task_id: "task:1".to_owned(),
        repo_id: "repo:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        remote_target: None,
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        base_branch: Some("main".to_owned()),
        head_branch: Some("feature/task".to_owned()),
        title_source: Some(ForgePullRequestTextSource::GeneratedFromEvidence),
        body_source: Some(ForgePullRequestTextSource::GeneratedFromEvidence),
        status: ForgePullRequestExecutionPreflightStatus::Ready,
        blockers: Vec::new(),
        pull_request_created: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        raw_output_retained: false,
    }
}
