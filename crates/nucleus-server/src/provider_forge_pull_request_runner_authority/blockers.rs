use crate::{ForgePullRequestExecutionPreflightRecord, ForgePullRequestExecutionPreflightStatus};

use super::types::{
    ForgePullRequestCreationScope, ForgePullRequestRunnerAuthorityBlocker,
    ForgePullRequestRunnerAuthorityContext, ForgePullRequestRunnerOperatorEffectIntent,
};

pub(super) fn blockers(
    context: &ForgePullRequestRunnerAuthorityContext,
    preflight: &ForgePullRequestExecutionPreflightRecord,
) -> Vec<ForgePullRequestRunnerAuthorityBlocker> {
    let mut blockers = Vec::new();
    if preflight.status != ForgePullRequestExecutionPreflightStatus::Ready {
        blockers.push(ForgePullRequestRunnerAuthorityBlocker::PreflightNotReady);
    }
    match &context.operator_effect_intent {
        ForgePullRequestRunnerOperatorEffectIntent::Missing => {
            blockers.push(ForgePullRequestRunnerAuthorityBlocker::OperatorEffectIntentMissing);
        }
        ForgePullRequestRunnerOperatorEffectIntent::Confirmed {
            allow_request_preparation,
            ..
        } if !allow_request_preparation => {
            blockers.push(ForgePullRequestRunnerAuthorityBlocker::RequestPreparationNotConfirmed);
        }
        ForgePullRequestRunnerOperatorEffectIntent::Confirmed { .. } => {}
        ForgePullRequestRunnerOperatorEffectIntent::PullRequestCreationConfirmed { scope, .. } => {
            if !scope.is_complete() {
                blockers.push(ForgePullRequestRunnerAuthorityBlocker::PullRequestCreationScopeMissing);
            }
            scope_mismatch_blockers(scope, preflight, &mut blockers);
        }
    }
    required_ref_blockers(preflight, &mut blockers);
    forbidden_blockers(context, &mut blockers);
    blockers
}

fn scope_mismatch_blockers(
    scope: &ForgePullRequestCreationScope,
    preflight: &ForgePullRequestExecutionPreflightRecord,
    blockers: &mut Vec<ForgePullRequestRunnerAuthorityBlocker>,
) {
    let mismatch = preflight.forge_provider != Some(scope.forge_provider.clone())
        || preflight.base_branch.as_deref() != Some(scope.base_branch.as_str())
        || preflight.head_branch.as_deref() != Some(scope.head_branch.as_str())
        || preflight.title_source != Some(scope.title_source.clone())
        || preflight.body_source != Some(scope.body_source.clone());
    if mismatch {
        blockers.push(ForgePullRequestRunnerAuthorityBlocker::PullRequestCreationScopeMismatch);
    }
}

fn required_ref_blockers(
    preflight: &ForgePullRequestExecutionPreflightRecord,
    blockers: &mut Vec<ForgePullRequestRunnerAuthorityBlocker>,
) {
    if preflight.forge_provider.is_none() {
        blockers.push(ForgePullRequestRunnerAuthorityBlocker::MissingForgeProvider);
    }
    if preflight
        .base_branch
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(ForgePullRequestRunnerAuthorityBlocker::MissingBaseBranch);
    }
    if preflight
        .head_branch
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(ForgePullRequestRunnerAuthorityBlocker::MissingHeadBranch);
    }
    if preflight.title_source.is_none() {
        blockers.push(ForgePullRequestRunnerAuthorityBlocker::MissingTitleSource);
    }
    if preflight.body_source.is_none() {
        blockers.push(ForgePullRequestRunnerAuthorityBlocker::MissingBodySource);
    }
}

fn forbidden_blockers(
    context: &ForgePullRequestRunnerAuthorityContext,
    blockers: &mut Vec<ForgePullRequestRunnerAuthorityBlocker>,
) {
    let creation_confirmed = matches!(
        context.operator_effect_intent,
        ForgePullRequestRunnerOperatorEffectIntent::PullRequestCreationConfirmed { .. }
    );
    if context.raw_output_retention_requested {
        blockers.push(ForgePullRequestRunnerAuthorityBlocker::RawOutputRetentionRequested);
    }
    if context.pull_request_creation_requested && !creation_confirmed {
        blockers.push(ForgePullRequestRunnerAuthorityBlocker::PullRequestCreationRequested);
    }
    if context.forge_effect_requested && !creation_confirmed {
        blockers.push(ForgePullRequestRunnerAuthorityBlocker::ForgeEffectRequested);
    }
    if context.provider_effect_requested {
        blockers.push(ForgePullRequestRunnerAuthorityBlocker::ProviderEffectRequested);
    }
    if context.callback_effect_requested {
        blockers.push(ForgePullRequestRunnerAuthorityBlocker::CallbackEffectRequested);
    }
    if context.interruption_effect_requested {
        blockers.push(ForgePullRequestRunnerAuthorityBlocker::InterruptionEffectRequested);
    }
    if context.recovery_effect_requested {
        blockers.push(ForgePullRequestRunnerAuthorityBlocker::RecoveryEffectRequested);
    }
    if context.task_mutation_requested {
        blockers.push(ForgePullRequestRunnerAuthorityBlocker::TaskMutationRequested);
    }
}
