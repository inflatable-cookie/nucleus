//! Stopped provider status/check refresh records and control DTOs.

mod blockers;
mod record_builder;
mod types;

pub use types::{
    ForgeStatusCheckRefreshBlocker, ForgeStatusCheckRefreshControlDto,
    ForgeStatusCheckRefreshInput, ForgeStatusCheckRefreshRecord, ForgeStatusCheckRefreshScope,
    ForgeStatusCheckRefreshSet, ForgeStatusCheckRefreshStatus,
};

use record_builder::refresh_record;

pub fn forge_status_check_refresh(
    input: ForgeStatusCheckRefreshInput,
) -> ForgeStatusCheckRefreshSet {
    let mut records = input
        .provider_context_refs
        .iter()
        .cloned()
        .map(|provider_context_ref| refresh_record(&input, provider_context_ref))
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.refresh_id.cmp(&right.refresh_id));

    ForgeStatusCheckRefreshSet {
        refresh_set_id: "forge-status-check-refresh".to_owned(),
        skipped_provider_context_refs: records
            .iter()
            .filter(|record| record.status != ForgeStatusCheckRefreshStatus::ReadyForStoppedRefresh)
            .map(|record| record.provider_context_ref.clone())
            .collect(),
        stopped_refresh_recorded: records.iter().any(|record| record.stopped_refresh_recorded),
        records,
        credential_resolution_performed: false,
        provider_network_call_performed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

pub fn forge_status_check_refresh_control_dto(
    set: &ForgeStatusCheckRefreshSet,
) -> ForgeStatusCheckRefreshControlDto {
    ForgeStatusCheckRefreshControlDto {
        dto_id: "forge-status-check-refresh-control-dto".to_owned(),
        refresh_set_id: set.refresh_set_id.clone(),
        refresh_count: set.records.len(),
        ready_count: status_count(set, ForgeStatusCheckRefreshStatus::ReadyForStoppedRefresh),
        repair_required_count: status_count(set, ForgeStatusCheckRefreshStatus::RepairRequired),
        blocked_count: status_count(set, ForgeStatusCheckRefreshStatus::Blocked),
        blocker_count: set.records.iter().map(|record| record.blockers.len()).sum(),
        skipped_provider_context_count: set.skipped_provider_context_refs.len(),
        stopped_refresh_recorded: set.stopped_refresh_recorded,
        credential_resolution_performed: false,
        provider_network_call_performed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn status_count(set: &ForgeStatusCheckRefreshSet, status: ForgeStatusCheckRefreshStatus) -> usize {
    set.records
        .iter()
        .filter(|record| record.status == status)
        .count()
}

#[cfg(test)]
mod tests;
