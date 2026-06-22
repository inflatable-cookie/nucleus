use crate::{GitCommitPreflightRecord, GitCommitPreflightStatus};

use super::types::{
    GitCommitRunnerAuthorityBlocker, GitCommitRunnerAuthorityContext,
    GitCommitRunnerOperatorEffectIntent, GitCommitRunnerTargetRef,
};

pub(super) fn blockers(
    context: &GitCommitRunnerAuthorityContext,
    preflight: &GitCommitPreflightRecord,
    target_ref: Option<&GitCommitRunnerTargetRef>,
) -> Vec<GitCommitRunnerAuthorityBlocker> {
    let mut blockers = Vec::new();
    if preflight.status != GitCommitPreflightStatus::Ready {
        blockers.push(GitCommitRunnerAuthorityBlocker::PreflightNotReady);
    }
    operator_blockers(&context.operator_effect_intent, &mut blockers);
    target_blockers(target_ref, &mut blockers);
    forbidden_authority_blockers(context, &mut blockers);
    blockers
}

fn operator_blockers(
    intent: &GitCommitRunnerOperatorEffectIntent,
    blockers: &mut Vec<GitCommitRunnerAuthorityBlocker>,
) {
    match intent {
        GitCommitRunnerOperatorEffectIntent::Missing => {
            blockers.push(GitCommitRunnerAuthorityBlocker::OperatorEffectIntentMissing);
        }
        GitCommitRunnerOperatorEffectIntent::Confirmed {
            allow_commit_creation,
            ..
        } if !allow_commit_creation => {
            blockers.push(GitCommitRunnerAuthorityBlocker::CommitCreationNotConfirmed);
        }
        GitCommitRunnerOperatorEffectIntent::Confirmed { .. } => {}
    }
}

fn target_blockers(
    target_ref: Option<&GitCommitRunnerTargetRef>,
    blockers: &mut Vec<GitCommitRunnerAuthorityBlocker>,
) {
    let Some(target_ref) = target_ref else {
        blockers.push(GitCommitRunnerAuthorityBlocker::MissingRunnerTarget);
        return;
    };
    if target_ref
        .commit_message_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(GitCommitRunnerAuthorityBlocker::MissingCommitMessageRef);
    }
}

fn forbidden_authority_blockers(
    context: &GitCommitRunnerAuthorityContext,
    blockers: &mut Vec<GitCommitRunnerAuthorityBlocker>,
) {
    if context.raw_output_retention_requested {
        blockers.push(GitCommitRunnerAuthorityBlocker::RawOutputRetentionRequested);
    }
    if context.push_requested {
        blockers.push(GitCommitRunnerAuthorityBlocker::PushRequested);
    }
    if context.pull_request_requested {
        blockers.push(GitCommitRunnerAuthorityBlocker::PullRequestRequested);
    }
    if context.forge_effect_requested {
        blockers.push(GitCommitRunnerAuthorityBlocker::ForgeEffectRequested);
    }
    if context.provider_effect_requested {
        blockers.push(GitCommitRunnerAuthorityBlocker::ProviderEffectRequested);
    }
    if context.callback_effect_requested {
        blockers.push(GitCommitRunnerAuthorityBlocker::CallbackEffectRequested);
    }
    if context.interruption_effect_requested {
        blockers.push(GitCommitRunnerAuthorityBlocker::InterruptionEffectRequested);
    }
    if context.recovery_effect_requested {
        blockers.push(GitCommitRunnerAuthorityBlocker::RecoveryEffectRequested);
    }
    if context.task_mutation_requested {
        blockers.push(GitCommitRunnerAuthorityBlocker::TaskMutationRequested);
    }
}
