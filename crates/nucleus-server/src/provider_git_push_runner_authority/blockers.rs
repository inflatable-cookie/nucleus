use crate::{GitPushPreflightRecord, GitPushPreflightStatus, GitPushRemoteTarget};

use super::types::{
    GitPushRunnerAuthorityBlocker, GitPushRunnerAuthorityContext, GitPushRunnerOperatorEffectIntent,
};

pub(super) fn blockers(
    context: &GitPushRunnerAuthorityContext,
    preflight: &GitPushPreflightRecord,
) -> Vec<GitPushRunnerAuthorityBlocker> {
    let mut blockers = Vec::new();
    if preflight.status != GitPushPreflightStatus::Ready {
        blockers.push(GitPushRunnerAuthorityBlocker::PreflightNotReady);
    }
    operator_blockers(&context.operator_effect_intent, &mut blockers);
    target_blockers(preflight.remote_target.as_ref(), &mut blockers);
    forbidden_authority_blockers(context, &mut blockers);
    blockers
}

fn operator_blockers(
    intent: &GitPushRunnerOperatorEffectIntent,
    blockers: &mut Vec<GitPushRunnerAuthorityBlocker>,
) {
    match intent {
        GitPushRunnerOperatorEffectIntent::Missing => {
            blockers.push(GitPushRunnerAuthorityBlocker::OperatorEffectIntentMissing);
        }
        GitPushRunnerOperatorEffectIntent::Confirmed {
            allow_push_execution,
            ..
        } if !allow_push_execution => {
            blockers.push(GitPushRunnerAuthorityBlocker::PushExecutionNotConfirmed);
        }
        GitPushRunnerOperatorEffectIntent::Confirmed { .. } => {}
    }
}

fn target_blockers(
    target: Option<&GitPushRemoteTarget>,
    blockers: &mut Vec<GitPushRunnerAuthorityBlocker>,
) {
    let Some(target) = target else {
        blockers.push(GitPushRunnerAuthorityBlocker::MissingRemoteTarget);
        return;
    };
    if target.remote_name.trim().is_empty() {
        blockers.push(GitPushRunnerAuthorityBlocker::MissingRemoteName);
    }
    if target.branch_name.trim().is_empty() {
        blockers.push(GitPushRunnerAuthorityBlocker::MissingBranchName);
    }
}

fn forbidden_authority_blockers(
    context: &GitPushRunnerAuthorityContext,
    blockers: &mut Vec<GitPushRunnerAuthorityBlocker>,
) {
    if context.raw_output_retention_requested {
        blockers.push(GitPushRunnerAuthorityBlocker::RawOutputRetentionRequested);
    }
    if context.pull_request_requested {
        blockers.push(GitPushRunnerAuthorityBlocker::PullRequestRequested);
    }
    if context.forge_effect_requested {
        blockers.push(GitPushRunnerAuthorityBlocker::ForgeEffectRequested);
    }
    if context.provider_effect_requested {
        blockers.push(GitPushRunnerAuthorityBlocker::ProviderEffectRequested);
    }
    if context.callback_effect_requested {
        blockers.push(GitPushRunnerAuthorityBlocker::CallbackEffectRequested);
    }
    if context.interruption_effect_requested {
        blockers.push(GitPushRunnerAuthorityBlocker::InterruptionEffectRequested);
    }
    if context.recovery_effect_requested {
        blockers.push(GitPushRunnerAuthorityBlocker::RecoveryEffectRequested);
    }
    if context.task_mutation_requested {
        blockers.push(GitPushRunnerAuthorityBlocker::TaskMutationRequested);
    }
}
