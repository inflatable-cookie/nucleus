//! Stopped provider pull-request/merge-request refresh records and control DTOs.

mod blockers;
mod record_builder;
mod types;

pub use types::{
    ForgePullRequestRefreshBlocker, ForgePullRequestRefreshControlDto,
    ForgePullRequestRefreshInput, ForgePullRequestRefreshRecord, ForgePullRequestRefreshScope,
    ForgePullRequestRefreshSet, ForgePullRequestRefreshStatus,
};

use crate::provider_no_effects::ProviderRuntimeNoEffects;
use record_builder::refresh_record;

pub fn forge_pull_request_refresh(
    input: ForgePullRequestRefreshInput,
) -> ForgePullRequestRefreshSet {
    let mut records = input
        .provider_context_refs
        .iter()
        .cloned()
        .map(|provider_context_ref| refresh_record(&input, provider_context_ref))
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.refresh_id.cmp(&right.refresh_id));

    ForgePullRequestRefreshSet {
        refresh_set_id: "forge-pull-request-refresh".to_owned(),
        skipped_provider_context_refs: records
            .iter()
            .filter(|record| record.status != ForgePullRequestRefreshStatus::ReadyForStoppedRefresh)
            .map(|record| record.provider_context_ref.clone())
            .collect(),
        stopped_refresh_recorded: records.iter().any(|record| record.stopped_refresh_recorded),
        records,
        no_effects: ProviderRuntimeNoEffects::none(),
    }
}

pub fn forge_pull_request_refresh_control_dto(
    set: &ForgePullRequestRefreshSet,
) -> ForgePullRequestRefreshControlDto {
    ForgePullRequestRefreshControlDto {
        dto_id: "forge-pull-request-refresh-control-dto".to_owned(),
        refresh_set_id: set.refresh_set_id.clone(),
        refresh_count: set.records.len(),
        ready_count: status_count(set, ForgePullRequestRefreshStatus::ReadyForStoppedRefresh),
        repair_required_count: status_count(set, ForgePullRequestRefreshStatus::RepairRequired),
        blocked_count: status_count(set, ForgePullRequestRefreshStatus::Blocked),
        blocker_count: set.records.iter().map(|record| record.blockers.len()).sum(),
        skipped_provider_context_count: set.skipped_provider_context_refs.len(),
        stopped_refresh_recorded: set.stopped_refresh_recorded,
        no_effects: ProviderRuntimeNoEffects::none(),
    }
}

fn status_count(set: &ForgePullRequestRefreshSet, status: ForgePullRequestRefreshStatus) -> usize {
    set.records
        .iter()
        .filter(|record| record.status == status)
        .count()
}

#[cfg(test)]
mod tests;
