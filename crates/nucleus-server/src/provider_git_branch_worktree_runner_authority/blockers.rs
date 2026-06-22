use crate::{GitBranchWorktreeExecutionHandoffRecord, GitBranchWorktreeExecutionHandoffStatus};

use super::types::{
    GitBranchWorktreeRunnerAuthorityBlocker, GitBranchWorktreeRunnerAuthorityContext,
    GitBranchWorktreeRunnerOperatorEffectIntent, GitBranchWorktreeRunnerTargetRef,
};
use crate::GitBranchWorktreeMode;

pub(super) fn blockers(
    context: &GitBranchWorktreeRunnerAuthorityContext,
    handoff: &GitBranchWorktreeExecutionHandoffRecord,
    target_ref: Option<&GitBranchWorktreeRunnerTargetRef>,
) -> Vec<GitBranchWorktreeRunnerAuthorityBlocker> {
    let mut blockers = Vec::new();
    if handoff.status != GitBranchWorktreeExecutionHandoffStatus::Admitted {
        blockers.push(GitBranchWorktreeRunnerAuthorityBlocker::HandoffNotAdmitted);
    }
    operator_blockers(
        &context.operator_effect_intent,
        &handoff.worktree_mode,
        &mut blockers,
    );
    target_blockers(target_ref, &handoff.worktree_mode, &mut blockers);
    forbidden_authority_blockers(context, &mut blockers);
    blockers
}

fn operator_blockers(
    intent: &GitBranchWorktreeRunnerOperatorEffectIntent,
    mode: &GitBranchWorktreeMode,
    blockers: &mut Vec<GitBranchWorktreeRunnerAuthorityBlocker>,
) {
    match intent {
        GitBranchWorktreeRunnerOperatorEffectIntent::Missing => {
            blockers.push(GitBranchWorktreeRunnerAuthorityBlocker::OperatorEffectIntentMissing);
        }
        GitBranchWorktreeRunnerOperatorEffectIntent::Confirmed {
            allow_primary_tree_checkout,
            allow_isolated_worktree_creation,
            ..
        } => match mode {
            GitBranchWorktreeMode::PrimaryTree if !allow_primary_tree_checkout => blockers
                .push(GitBranchWorktreeRunnerAuthorityBlocker::PrimaryTreeCheckoutNotConfirmed),
            GitBranchWorktreeMode::IsolatedWorktree if !allow_isolated_worktree_creation => {
                blockers.push(
                    GitBranchWorktreeRunnerAuthorityBlocker::IsolatedWorktreeCreationNotConfirmed,
                );
            }
            _ => {}
        },
    }
}

fn target_blockers(
    target_ref: Option<&GitBranchWorktreeRunnerTargetRef>,
    mode: &GitBranchWorktreeMode,
    blockers: &mut Vec<GitBranchWorktreeRunnerAuthorityBlocker>,
) {
    let Some(target_ref) = target_ref else {
        blockers.push(GitBranchWorktreeRunnerAuthorityBlocker::MissingRunnerTarget);
        return;
    };
    if target_ref
        .branch_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(GitBranchWorktreeRunnerAuthorityBlocker::MissingBranchRef);
    }
    if mode == &GitBranchWorktreeMode::IsolatedWorktree
        && target_ref
            .worktree_location_ref
            .as_deref()
            .unwrap_or_default()
            .is_empty()
    {
        blockers.push(GitBranchWorktreeRunnerAuthorityBlocker::MissingIsolatedWorktreeLocationRef);
    }
}

fn forbidden_authority_blockers(
    context: &GitBranchWorktreeRunnerAuthorityContext,
    blockers: &mut Vec<GitBranchWorktreeRunnerAuthorityBlocker>,
) {
    if context.raw_output_retention_requested {
        blockers.push(GitBranchWorktreeRunnerAuthorityBlocker::RawOutputRetentionRequested);
    }
    if context.commit_requested {
        blockers.push(GitBranchWorktreeRunnerAuthorityBlocker::CommitRequested);
    }
    if context.push_requested {
        blockers.push(GitBranchWorktreeRunnerAuthorityBlocker::PushRequested);
    }
    if context.pull_request_requested {
        blockers.push(GitBranchWorktreeRunnerAuthorityBlocker::PullRequestRequested);
    }
    if context.forge_effect_requested {
        blockers.push(GitBranchWorktreeRunnerAuthorityBlocker::ForgeEffectRequested);
    }
    if context.provider_effect_requested {
        blockers.push(GitBranchWorktreeRunnerAuthorityBlocker::ProviderEffectRequested);
    }
    if context.callback_effect_requested {
        blockers.push(GitBranchWorktreeRunnerAuthorityBlocker::CallbackEffectRequested);
    }
    if context.interruption_effect_requested {
        blockers.push(GitBranchWorktreeRunnerAuthorityBlocker::InterruptionEffectRequested);
    }
    if context.recovery_effect_requested {
        blockers.push(GitBranchWorktreeRunnerAuthorityBlocker::RecoveryEffectRequested);
    }
    if context.task_mutation_requested {
        blockers.push(GitBranchWorktreeRunnerAuthorityBlocker::TaskMutationRequested);
    }
}
