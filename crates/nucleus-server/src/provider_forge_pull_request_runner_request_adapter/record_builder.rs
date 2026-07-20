use crate::provider_no_effects::ForgeScmNoEffects;
use crate::{ForgePullRequestRunnerAuthorityRecord, ForgePullRequestRunnerAuthorityStatus};

use super::types::{
    ForgePullRequestRunnerRequestAdapterBlocker, ForgePullRequestRunnerRequestAdapterInput,
    ForgePullRequestRunnerRequestAdapterRecord, ForgePullRequestRunnerRequestAdapterStatus,
};

pub(super) fn request_record(
    input: &ForgePullRequestRunnerRequestAdapterInput,
    authority: ForgePullRequestRunnerAuthorityRecord,
) -> ForgePullRequestRunnerRequestAdapterRecord {
    let blockers = blockers(input, &authority);
    let status = status(&blockers);
    let provider_request_prepared = status == ForgePullRequestRunnerRequestAdapterStatus::Ready;

    ForgePullRequestRunnerRequestAdapterRecord {
        request_adapter_id: format!(
            "forge-pull-request-runner-request:{}",
            authority.authority_id
        ),
        authority_id: authority.authority_id,
        preflight_id: authority.preflight_id,
        admission_id: authority.admission_id,
        pr_evidence_id: authority.pr_evidence_id,
        pr_descriptor_id: authority.pr_descriptor_id,
        push_preflight_id: authority.push_preflight_id,
        request_id: authority.request_id,
        upstream_authority_id: authority.upstream_authority_id,
        git_plan_id: authority.git_plan_id,
        task_id: authority.task_id,
        repo_id: authority.repo_id,
        operator_ref: authority.operator_ref,
        operator_confirmation_ref: authority.operator_confirmation_ref,
        remote_target: authority.remote_target,
        forge_provider: authority.forge_provider,
        base_branch: authority.base_branch,
        head_branch: authority.head_branch,
        title_source: authority.title_source,
        body_source: authority.body_source,
        status,
        blockers,
        provider_request_prepared,
        shell_passthrough_used: false,
        shell_execution_performed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

fn blockers(
    input: &ForgePullRequestRunnerRequestAdapterInput,
    authority: &ForgePullRequestRunnerAuthorityRecord,
) -> Vec<ForgePullRequestRunnerRequestAdapterBlocker> {
    let mut blockers = Vec::new();
    if authority.status != ForgePullRequestRunnerAuthorityStatus::ReadyForRequest {
        blockers.push(ForgePullRequestRunnerRequestAdapterBlocker::AuthorityNotReady);
    }
    if authority.forge_provider.is_none() {
        blockers.push(ForgePullRequestRunnerRequestAdapterBlocker::MissingForgeProvider);
    }
    if authority
        .base_branch
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(ForgePullRequestRunnerRequestAdapterBlocker::MissingBaseBranch);
    }
    if authority
        .head_branch
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(ForgePullRequestRunnerRequestAdapterBlocker::MissingHeadBranch);
    }
    if authority.title_source.is_none() {
        blockers.push(ForgePullRequestRunnerRequestAdapterBlocker::MissingTitleSource);
    }
    if authority.body_source.is_none() {
        blockers.push(ForgePullRequestRunnerRequestAdapterBlocker::MissingBodySource);
    }
    forbidden_blockers(input, &mut blockers);
    blockers
}

fn forbidden_blockers(
    input: &ForgePullRequestRunnerRequestAdapterInput,
    blockers: &mut Vec<ForgePullRequestRunnerRequestAdapterBlocker>,
) {
    if input.shell_passthrough_requested {
        blockers.push(ForgePullRequestRunnerRequestAdapterBlocker::ShellPassthroughRequested);
    }
    if input.raw_output_retention_requested {
        blockers.push(ForgePullRequestRunnerRequestAdapterBlocker::RawOutputRetentionRequested);
    }
    if input.pull_request_creation_requested {
        blockers.push(ForgePullRequestRunnerRequestAdapterBlocker::PullRequestCreationRequested);
    }
    if input.forge_effect_requested {
        blockers.push(ForgePullRequestRunnerRequestAdapterBlocker::ForgeEffectRequested);
    }
    if input.provider_effect_requested {
        blockers.push(ForgePullRequestRunnerRequestAdapterBlocker::ProviderEffectRequested);
    }
    if input.callback_effect_requested {
        blockers.push(ForgePullRequestRunnerRequestAdapterBlocker::CallbackEffectRequested);
    }
    if input.interruption_effect_requested {
        blockers.push(ForgePullRequestRunnerRequestAdapterBlocker::InterruptionEffectRequested);
    }
    if input.recovery_effect_requested {
        blockers.push(ForgePullRequestRunnerRequestAdapterBlocker::RecoveryEffectRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ForgePullRequestRunnerRequestAdapterBlocker::TaskMutationRequested);
    }
}

fn status(
    blockers: &[ForgePullRequestRunnerRequestAdapterBlocker],
) -> ForgePullRequestRunnerRequestAdapterStatus {
    if blockers.is_empty() {
        ForgePullRequestRunnerRequestAdapterStatus::Ready
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ForgePullRequestRunnerRequestAdapterBlocker::AuthorityNotReady
                | ForgePullRequestRunnerRequestAdapterBlocker::MissingForgeProvider
                | ForgePullRequestRunnerRequestAdapterBlocker::MissingBaseBranch
                | ForgePullRequestRunnerRequestAdapterBlocker::MissingHeadBranch
                | ForgePullRequestRunnerRequestAdapterBlocker::MissingTitleSource
                | ForgePullRequestRunnerRequestAdapterBlocker::MissingBodySource
        )
    }) {
        ForgePullRequestRunnerRequestAdapterStatus::RepairRequired
    } else {
        ForgePullRequestRunnerRequestAdapterStatus::Blocked
    }
}
