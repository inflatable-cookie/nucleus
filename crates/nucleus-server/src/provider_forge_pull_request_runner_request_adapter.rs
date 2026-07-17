//! Sanitized provider request records for stopped forge pull-request runners.

mod record_builder;
mod types;

pub use types::{
    ForgePullRequestRunnerRequestAdapterBlocker, ForgePullRequestRunnerRequestAdapterInput,
    ForgePullRequestRunnerRequestAdapterRecord, ForgePullRequestRunnerRequestAdapterSet,
    ForgePullRequestRunnerRequestAdapterStatus,
};

use crate::provider_no_effects::{ForgeScmNoEffects};
use record_builder::request_record;

pub fn forge_pull_request_runner_request_adapter(
    input: ForgePullRequestRunnerRequestAdapterInput,
) -> ForgePullRequestRunnerRequestAdapterSet {
    let mut requests = input
        .authorities
        .authorities
        .iter()
        .cloned()
        .map(|authority| request_record(&input, authority))
        .collect::<Vec<_>>();
    requests.sort_by(|left, right| left.request_adapter_id.cmp(&right.request_adapter_id));
    let provider_request_prepared = requests
        .iter()
        .any(|request| request.provider_request_prepared);

    ForgePullRequestRunnerRequestAdapterSet {
        request_set_id: "forge-pull-request-runner-request-adapter".to_owned(),
        skipped_authority_ids: requests
            .iter()
            .filter(|request| request.status != ForgePullRequestRunnerRequestAdapterStatus::Ready)
            .map(|request| request.authority_id.clone())
            .collect(),
        requests,
        provider_request_prepared,
        shell_passthrough_used: false,
        shell_execution_performed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

#[cfg(test)]
mod tests;
