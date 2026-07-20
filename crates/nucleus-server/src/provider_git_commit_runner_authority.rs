//! Authority records for Git commit runner execution.

mod blockers;
mod record_builder;
mod types;

pub use types::{
    GitCommitRunnerAuthorityBlocker, GitCommitRunnerAuthorityInput, GitCommitRunnerAuthorityRecord,
    GitCommitRunnerAuthoritySet, GitCommitRunnerAuthorityStatus,
    GitCommitRunnerOperatorEffectIntent, GitCommitRunnerTargetRef,
};

use crate::provider_no_effects::ForgeScmNoEffects;
use record_builder::authority_record;
use types::GitCommitRunnerAuthorityContext;

pub fn git_commit_runner_authority(
    input: GitCommitRunnerAuthorityInput,
) -> GitCommitRunnerAuthoritySet {
    let context = GitCommitRunnerAuthorityContext {
        operator_effect_intent: input.operator_effect_intent,
        target_refs: input.target_refs,
        raw_output_retention_requested: input.raw_output_retention_requested,
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
        .preflights
        .preflights
        .into_iter()
        .map(|preflight| authority_record(&context, preflight))
        .collect::<Vec<_>>();
    authorities.sort_by(|left, right| left.authority_id.cmp(&right.authority_id));
    let runner_invocation_permitted = authorities
        .iter()
        .any(|authority| authority.runner_invocation_permitted);

    GitCommitRunnerAuthoritySet {
        authority_set_id: "git-commit-runner-authority".to_owned(),
        skipped_preflight_ids: authorities
            .iter()
            .filter(|authority| authority.status != GitCommitRunnerAuthorityStatus::ReadyForRunner)
            .map(|authority| authority.preflight_id.clone())
            .collect(),
        authorities,
        runner_invocation_permitted,
        shell_execution_performed: false,
        commit_created: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

#[cfg(test)]
mod tests;
