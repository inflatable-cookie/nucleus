use crate::provider_no_effects::{ForgeScmNoEffects};
use super::*;
use crate::{
    ForgePullRequestProvider, ForgePullRequestRunnerAuthorityRecord,
    ForgePullRequestRunnerAuthoritySet, ForgePullRequestRunnerAuthorityStatus,
    ForgePullRequestTextSource,
};

#[test]
fn forge_pull_request_runner_request_adapter_prepares_sanitized_request() {
    let set = forge_pull_request_runner_request_adapter(input(false));
    let request = &set.requests[0];

    assert_eq!(
        request.status,
        ForgePullRequestRunnerRequestAdapterStatus::Ready
    );
    assert!(request.provider_request_prepared);
    assert_eq!(
        request.forge_provider,
        Some(ForgePullRequestProvider::GitHub)
    );
    assert_eq!(request.base_branch, Some("main".to_owned()));
    assert!(!request.no_effects.pull_request_created);
    assert!(!request.no_effects.provider_effect_executed);
}

#[test]
fn forge_pull_request_runner_request_adapter_blocks_provider_widening() {
    let set = forge_pull_request_runner_request_adapter(input(true));
    let request = &set.requests[0];

    assert_eq!(
        request.status,
        ForgePullRequestRunnerRequestAdapterStatus::Blocked
    );
    assert!(request
        .blockers
        .contains(&ForgePullRequestRunnerRequestAdapterBlocker::PullRequestCreationRequested));
    assert!(request
        .blockers
        .contains(&ForgePullRequestRunnerRequestAdapterBlocker::ProviderEffectRequested));
}

fn input(forbidden: bool) -> ForgePullRequestRunnerRequestAdapterInput {
    ForgePullRequestRunnerRequestAdapterInput {
        authorities: authority_set(),
        shell_passthrough_requested: forbidden,
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

fn authority_set() -> ForgePullRequestRunnerAuthoritySet {
    ForgePullRequestRunnerAuthoritySet {
        authority_set_id: "authority-set:1".to_owned(),
        authorities: vec![authority()],
        skipped_preflight_ids: Vec::new(),
        request_preparation_permitted: true,
        shell_execution_performed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

fn authority() -> ForgePullRequestRunnerAuthorityRecord {
    ForgePullRequestRunnerAuthorityRecord {
        authority_id: "authority:1".to_owned(),
        preflight_id: "preflight:1".to_owned(),
        admission_id: "admission:1".to_owned(),
        pr_evidence_id: "pr-evidence:1".to_owned(),
        pr_descriptor_id: "pr-descriptor:1".to_owned(),
        push_preflight_id: "push-preflight:1".to_owned(),
        request_id: "request:1".to_owned(),
        upstream_authority_id: "upstream-authority:1".to_owned(),
        git_plan_id: "git-plan:1".to_owned(),
        task_id: "task:1".to_owned(),
        repo_id: "repo:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        operator_confirmation_ref: Some("confirmation:1".to_owned()),
        remote_target: None,
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        base_branch: Some("main".to_owned()),
        head_branch: Some("feature/task".to_owned()),
        title_source: Some(ForgePullRequestTextSource::GeneratedFromEvidence),
        body_source: Some(ForgePullRequestTextSource::GeneratedFromEvidence),
        status: ForgePullRequestRunnerAuthorityStatus::ReadyForRequest,
        blockers: Vec::new(),
        request_preparation_permitted: true,
        shell_execution_performed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}
