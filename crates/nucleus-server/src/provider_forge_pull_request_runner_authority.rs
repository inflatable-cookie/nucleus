//! Stopped authority records for forge pull-request request preparation.

mod blockers;
mod record_builder;
mod types;

pub use types::{
    ForgePullRequestRunnerAuthorityBlocker, ForgePullRequestRunnerAuthorityInput,
    ForgePullRequestRunnerAuthorityRecord, ForgePullRequestRunnerAuthoritySet,
    ForgePullRequestRunnerAuthorityStatus, ForgePullRequestRunnerOperatorEffectIntent,
};

use crate::provider_no_effects::{ForgeScmNoEffects};
use record_builder::authority_record;
use types::ForgePullRequestRunnerAuthorityContext;

pub fn forge_pull_request_runner_authority(
    input: ForgePullRequestRunnerAuthorityInput,
) -> ForgePullRequestRunnerAuthoritySet {
    let context = ForgePullRequestRunnerAuthorityContext {
        operator_effect_intent: input.operator_effect_intent,
        raw_output_retention_requested: input.raw_output_retention_requested,
        pull_request_creation_requested: input.pull_request_creation_requested,
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
    let request_preparation_permitted = authorities
        .iter()
        .any(|authority| authority.request_preparation_permitted);

    ForgePullRequestRunnerAuthoritySet {
        authority_set_id: "forge-pull-request-runner-authority".to_owned(),
        skipped_preflight_ids: authorities
            .iter()
            .filter(|authority| {
                authority.status != ForgePullRequestRunnerAuthorityStatus::ReadyForRequest
            })
            .map(|authority| authority.preflight_id.clone())
            .collect(),
        authorities,
        request_preparation_permitted,
        shell_execution_performed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

#[cfg(test)]
mod tests;
