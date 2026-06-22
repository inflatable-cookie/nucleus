use super::super::executor_types::{
    ProviderLiveReadCommandHandoffDiagnostics, ProviderLiveReadCommandHandoffRecord,
    ProviderLiveReadCommandHandoffStatus, ProviderLiveReadCommandResultMappingRecord,
    ProviderLiveReadCommandResultMappingStatus, ProviderLiveReadServerReceiptStatus,
};

pub fn provider_live_read_command_handoff_diagnostics(
    handoffs: Vec<ProviderLiveReadCommandHandoffRecord>,
    mappings: Vec<ProviderLiveReadCommandResultMappingRecord>,
) -> ProviderLiveReadCommandHandoffDiagnostics {
    ProviderLiveReadCommandHandoffDiagnostics {
        diagnostics_id: "provider-live-read-command-handoff-diagnostics".to_owned(),
        handoff_count: handoffs.len(),
        ready_handoff_count: handoffs
            .iter()
            .filter(|record| {
                record.status == ProviderLiveReadCommandHandoffStatus::ReadyForReadOnlyCommand
            })
            .count(),
        blocked_handoff_count: handoffs
            .iter()
            .filter(|record| record.status == ProviderLiveReadCommandHandoffStatus::Blocked)
            .count(),
        duplicate_handoff_count: handoffs
            .iter()
            .filter(|record| record.status == ProviderLiveReadCommandHandoffStatus::DuplicateNoop)
            .count(),
        mapping_count: mappings.len(),
        mapped_output_count: mappings
            .iter()
            .filter(|record| {
                record.status == ProviderLiveReadCommandResultMappingStatus::MappedSanitizedOutput
            })
            .count(),
        parse_error_count: mappings
            .iter()
            .filter(|record| {
                record.status == ProviderLiveReadCommandResultMappingStatus::ParseError
            })
            .count(),
        receipt_count: mappings.len(),
        provider_network_read_performed_count: mappings
            .iter()
            .filter(|record| {
                record.receipt.status == ProviderLiveReadServerReceiptStatus::ProviderReadPerformed
                    && record.provider_network_call_performed
            })
            .count(),
        blocker_count: handoffs
            .iter()
            .map(|record| record.blockers.len())
            .sum::<usize>()
            + mappings
                .iter()
                .map(|record| record.blockers.len())
                .sum::<usize>(),
        provider_write_executed: handoffs.iter().any(|record| record.provider_write_executed)
            || mappings.iter().any(|record| record.provider_write_executed),
        callback_effect_executed: mappings
            .iter()
            .any(|record| record.callback_effect_executed),
        interruption_effect_executed: mappings
            .iter()
            .any(|record| record.interruption_effect_executed),
        recovery_effect_executed: mappings
            .iter()
            .any(|record| record.recovery_effect_executed),
        task_mutation_executed: handoffs.iter().any(|record| record.task_mutation_executed)
            || mappings.iter().any(|record| record.task_mutation_executed),
        raw_provider_payload_retained: handoffs
            .iter()
            .any(|record| record.raw_provider_payload_retained)
            || mappings
                .iter()
                .any(|record| record.raw_provider_payload_retained),
    }
}
