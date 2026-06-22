//! Stopped preflight records and control DTOs for forge network execution.

mod record_builder;
mod types;

pub use types::{
    ForgeNetworkExecutionPreflightBlocker, ForgeNetworkExecutionPreflightControlDto,
    ForgeNetworkExecutionPreflightInput, ForgeNetworkExecutionPreflightRecord,
    ForgeNetworkExecutionPreflightSet, ForgeNetworkExecutionPreflightStatus,
};

use record_builder::preflight_record;

pub fn forge_network_execution_preflight(
    input: ForgeNetworkExecutionPreflightInput,
) -> ForgeNetworkExecutionPreflightSet {
    let mut preflights = input
        .admissions
        .admissions
        .iter()
        .cloned()
        .map(|admission| preflight_record(&input, admission))
        .collect::<Vec<_>>();
    preflights.sort_by(|left, right| left.preflight_id.cmp(&right.preflight_id));
    let stopped_execution_request_permitted = preflights
        .iter()
        .any(|preflight| preflight.stopped_execution_request_permitted);

    ForgeNetworkExecutionPreflightSet {
        preflight_set_id: "forge-network-execution-preflight".to_owned(),
        skipped_admission_ids: preflights
            .iter()
            .filter(|preflight| {
                preflight.status
                    != ForgeNetworkExecutionPreflightStatus::ReadyForStoppedExecutionRequest
            })
            .map(|preflight| preflight.admission_id.clone())
            .collect(),
        preflights,
        stopped_execution_request_permitted,
        credential_resolution_performed: false,
        provider_network_call_performed: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

pub fn forge_network_execution_preflight_control_dto(
    set: &ForgeNetworkExecutionPreflightSet,
) -> ForgeNetworkExecutionPreflightControlDto {
    ForgeNetworkExecutionPreflightControlDto {
        dto_id: "forge-network-execution-preflight-control-dto".to_owned(),
        preflight_set_id: set.preflight_set_id.clone(),
        preflight_count: set.preflights.len(),
        ready_count: set
            .preflights
            .iter()
            .filter(|preflight| {
                preflight.status
                    == ForgeNetworkExecutionPreflightStatus::ReadyForStoppedExecutionRequest
            })
            .count(),
        repair_required_count: set
            .preflights
            .iter()
            .filter(|preflight| {
                preflight.status == ForgeNetworkExecutionPreflightStatus::RepairRequired
            })
            .count(),
        blocked_count: set
            .preflights
            .iter()
            .filter(|preflight| preflight.status == ForgeNetworkExecutionPreflightStatus::Blocked)
            .count(),
        blocker_count: set
            .preflights
            .iter()
            .map(|preflight| preflight.blockers.len())
            .sum(),
        skipped_admission_count: set.skipped_admission_ids.len(),
        stopped_execution_request_permitted: set.stopped_execution_request_permitted,
        credential_resolution_performed: false,
        provider_network_call_performed: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

#[cfg(test)]
mod tests;
