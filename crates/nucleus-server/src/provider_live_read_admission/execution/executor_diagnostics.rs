use super::executor_types::{
    ProviderLiveReadGhCommandDescriptorRecord, ProviderLiveReadGhCommandDescriptorStatus,
    ProviderLiveReadSanitizedRepositoryMetadataRecord,
    ProviderLiveReadSanitizedRepositoryMetadataStatus, ProviderLiveReadServerExecutorDiagnostics,
    ProviderLiveReadServerReceiptRecord, ProviderLiveReadServerReceiptStatus,
    ProviderLiveReadServerRequestRecord, ProviderLiveReadServerRequestStatus,
};

pub fn provider_live_read_server_executor_diagnostics(
    requests: Vec<ProviderLiveReadServerRequestRecord>,
    descriptors: Vec<ProviderLiveReadGhCommandDescriptorRecord>,
    outputs: Vec<ProviderLiveReadSanitizedRepositoryMetadataRecord>,
    receipts: Vec<ProviderLiveReadServerReceiptRecord>,
) -> ProviderLiveReadServerExecutorDiagnostics {
    ProviderLiveReadServerExecutorDiagnostics {
        diagnostics_id: "provider-live-read-server-executor-diagnostics".to_owned(),
        request_count: requests.len(),
        ready_request_count: requests
            .iter()
            .filter(|record| {
                record.status == ProviderLiveReadServerRequestStatus::ReadyForCommandDescriptor
            })
            .count(),
        blocked_request_count: requests
            .iter()
            .filter(|record| record.status == ProviderLiveReadServerRequestStatus::Blocked)
            .count(),
        descriptor_ready_count: descriptors
            .iter()
            .filter(|record| {
                record.status == ProviderLiveReadGhCommandDescriptorStatus::ReadyForReadOnlySpawn
            })
            .count(),
        sanitized_output_count: outputs
            .iter()
            .filter(|record| {
                record.status == ProviderLiveReadSanitizedRepositoryMetadataStatus::Sanitized
            })
            .count(),
        parse_error_count: outputs
            .iter()
            .filter(|record| {
                record.status == ProviderLiveReadSanitizedRepositoryMetadataStatus::ParseError
            })
            .count(),
        receipt_count: receipts.len(),
        provider_network_read_performed_count: receipts
            .iter()
            .filter(|record| {
                record.status == ProviderLiveReadServerReceiptStatus::ProviderReadPerformed
                    && record.provider_network_call_performed
            })
            .count(),
        blocker_count: requests
            .iter()
            .map(|record| record.blockers.len())
            .sum::<usize>()
            + descriptors
                .iter()
                .map(|record| record.blockers.len())
                .sum::<usize>()
            + outputs
                .iter()
                .map(|record| record.blockers.len())
                .sum::<usize>()
            + receipts
                .iter()
                .map(|record| record.blockers.len())
                .sum::<usize>(),
        provider_write_executed: requests.iter().any(|record| record.provider_write_executed)
            || descriptors
                .iter()
                .any(|record| record.provider_write_executed)
            || outputs.iter().any(|record| record.provider_write_executed)
            || receipts.iter().any(|record| record.provider_write_executed),
        callback_effect_executed: requests
            .iter()
            .any(|record| record.callback_effect_executed)
            || receipts
                .iter()
                .any(|record| record.callback_effect_executed),
        interruption_effect_executed: requests
            .iter()
            .any(|record| record.interruption_effect_executed)
            || receipts
                .iter()
                .any(|record| record.interruption_effect_executed),
        recovery_effect_executed: requests
            .iter()
            .any(|record| record.recovery_effect_executed)
            || receipts
                .iter()
                .any(|record| record.recovery_effect_executed),
        task_mutation_executed: requests.iter().any(|record| record.task_mutation_executed)
            || descriptors
                .iter()
                .any(|record| record.task_mutation_executed)
            || outputs.iter().any(|record| record.task_mutation_executed)
            || receipts.iter().any(|record| record.task_mutation_executed),
        raw_provider_payload_retained: requests
            .iter()
            .any(|record| record.raw_provider_payload_retained)
            || descriptors
                .iter()
                .any(|record| record.raw_provider_payload_retained)
            || outputs
                .iter()
                .any(|record| record.raw_provider_payload_retained)
            || receipts
                .iter()
                .any(|record| record.raw_provider_payload_retained),
    }
}
