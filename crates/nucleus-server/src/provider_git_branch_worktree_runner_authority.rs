//! Authority records for Git branch/worktree runner execution.

mod blockers;
mod record_builder;
mod types;

pub use types::{
    GitBranchWorktreeRunnerAction, GitBranchWorktreeRunnerAuthorityBlocker,
    GitBranchWorktreeRunnerAuthorityInput, GitBranchWorktreeRunnerAuthorityRecord,
    GitBranchWorktreeRunnerAuthoritySet, GitBranchWorktreeRunnerAuthorityStatus,
    GitBranchWorktreeRunnerOperatorEffectIntent, GitBranchWorktreeRunnerTargetRef,
};

use crate::provider_no_effects::ForgeScmNoEffects;
use record_builder::authority_record;
use types::GitBranchWorktreeRunnerAuthorityContext;

pub fn git_branch_worktree_runner_authority(
    input: GitBranchWorktreeRunnerAuthorityInput,
) -> GitBranchWorktreeRunnerAuthoritySet {
    let context = GitBranchWorktreeRunnerAuthorityContext {
        operator_effect_intent: input.operator_effect_intent,
        target_refs: input.target_refs,
        raw_output_retention_requested: input.raw_output_retention_requested,
        commit_requested: input.commit_requested,
        push_requested: input.push_requested,
        pull_request_requested: input.pull_request_requested,
        forge_effect_requested: input.forge_effect_requested,
        provider_effect_requested: input.provider_effect_requested,
        callback_effect_requested: input.callback_effect_requested,
        interruption_effect_requested: input.interruption_effect_requested,
        recovery_effect_requested: input.recovery_effect_requested,
        task_mutation_requested: input.task_mutation_requested,
    };
    let mut authorities = input
        .handoffs
        .handoffs
        .into_iter()
        .map(|handoff| authority_record(&context, handoff))
        .collect::<Vec<_>>();
    authorities.sort_by(|left, right| left.authority_id.cmp(&right.authority_id));
    let runner_invocation_permitted = authorities
        .iter()
        .any(|authority| authority.runner_invocation_permitted);

    GitBranchWorktreeRunnerAuthoritySet {
        authority_set_id: "git-branch-worktree-runner-authority".to_owned(),
        skipped_handoff_ids: authorities
            .iter()
            .filter(|authority| {
                authority.status != GitBranchWorktreeRunnerAuthorityStatus::ReadyForRunner
            })
            .map(|authority| authority.handoff_id.clone())
            .collect(),
        authorities,
        runner_invocation_permitted,
        shell_execution_performed: false,
        checkout_executed: false,
        branch_created: false,
        worktree_created: false,
        commit_created: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

#[cfg(test)]
mod tests;
