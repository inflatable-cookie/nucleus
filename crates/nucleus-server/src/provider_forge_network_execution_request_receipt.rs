//! Stopped request and receipt records for forge network execution.

mod record_builder;
mod types;

pub use types::{
    ForgeNetworkExecutionReceiptStatus, ForgeNetworkExecutionRequestReceiptBlocker,
    ForgeNetworkExecutionRequestReceiptControlDto, ForgeNetworkExecutionRequestReceiptInput,
    ForgeNetworkExecutionRequestReceiptRecord, ForgeNetworkExecutionRequestReceiptSet,
    ForgeNetworkExecutionRequestReceiptStatus,
};

use record_builder::request_receipt_record;

pub fn forge_network_execution_request_receipt(
    input: ForgeNetworkExecutionRequestReceiptInput,
) -> ForgeNetworkExecutionRequestReceiptSet {
    let mut request_receipts = input
        .preflights
        .preflights
        .iter()
        .cloned()
        .map(|preflight| request_receipt_record(&input, preflight))
        .collect::<Vec<_>>();
    request_receipts
        .sort_by(|left, right| left.execution_request_id.cmp(&right.execution_request_id));
    let stopped_request_recorded = request_receipts
        .iter()
        .any(|record| record.stopped_request_recorded);

    ForgeNetworkExecutionRequestReceiptSet {
        request_receipt_set_id: "forge-network-execution-request-receipt".to_owned(),
        skipped_preflight_ids: request_receipts
            .iter()
            .filter(|record| {
                record.status != ForgeNetworkExecutionRequestReceiptStatus::StoppedRequestRecorded
            })
            .map(|record| record.preflight_id.clone())
            .collect(),
        request_receipts,
        stopped_request_recorded,
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

pub fn forge_network_execution_request_receipt_control_dto(
    set: &ForgeNetworkExecutionRequestReceiptSet,
) -> ForgeNetworkExecutionRequestReceiptControlDto {
    ForgeNetworkExecutionRequestReceiptControlDto {
        dto_id: "forge-network-execution-request-receipt-control-dto".to_owned(),
        request_receipt_set_id: set.request_receipt_set_id.clone(),
        request_receipt_count: set.request_receipts.len(),
        recorded_count: set
            .request_receipts
            .iter()
            .filter(|record| {
                record.status == ForgeNetworkExecutionRequestReceiptStatus::StoppedRequestRecorded
            })
            .count(),
        repair_required_count: set
            .request_receipts
            .iter()
            .filter(|record| {
                record.status == ForgeNetworkExecutionRequestReceiptStatus::RepairRequired
            })
            .count(),
        blocked_count: set
            .request_receipts
            .iter()
            .filter(|record| record.status == ForgeNetworkExecutionRequestReceiptStatus::Blocked)
            .count(),
        blocker_count: set
            .request_receipts
            .iter()
            .map(|record| record.blockers.len())
            .sum(),
        skipped_preflight_count: set.skipped_preflight_ids.len(),
        stopped_request_recorded: set.stopped_request_recorded,
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
