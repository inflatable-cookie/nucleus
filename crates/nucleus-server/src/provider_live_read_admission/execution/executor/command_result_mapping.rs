use super::super::executor_types::{
    ProviderLiveReadCommandHandoffStatus, ProviderLiveReadCommandResultMappingBlocker,
    ProviderLiveReadCommandResultMappingInput, ProviderLiveReadCommandResultMappingRecord,
    ProviderLiveReadCommandResultMappingStatus, ProviderLiveReadSanitizedRepositoryMetadataStatus,
    ProviderLiveReadServerReceiptInput, ProviderLiveReadServerReceiptStatus,
};
use super::{
    provider_live_read_sanitized_repository_metadata_output, provider_live_read_server_receipt,
};

pub fn provider_live_read_command_result_mapping(
    input: ProviderLiveReadCommandResultMappingInput,
) -> ProviderLiveReadCommandResultMappingRecord {
    let output = provider_live_read_sanitized_repository_metadata_output(
        &input.descriptor,
        &input.command_stdout_json,
    );
    let receipt = provider_live_read_server_receipt(ProviderLiveReadServerReceiptInput {
        request: input.request.clone(),
        descriptor: input.descriptor.clone(),
        output: output.clone(),
        provider_exit_code: input.command_exit_status,
        receipt_evidence_ref: input.receipt_evidence_ref.clone(),
        provider_network_call_performed: input.command_succeeded,
        provider_write_executed: input.provider_write_executed,
        callback_effect_executed: input.callback_effect_executed,
        interruption_effect_executed: input.interruption_effect_executed,
        recovery_effect_executed: input.recovery_effect_executed,
        task_mutation_executed: input.task_mutation_executed,
        raw_provider_payload_retained: input.raw_provider_payload_retained,
    });
    let blockers = blockers(&input, &output, &receipt);
    let status = status(&blockers, &output);

    ProviderLiveReadCommandResultMappingRecord {
        mapping_id: format!(
            "provider-live-read-command-result:{}",
            input.handoff.handoff_id
        ),
        handoff_id: input.handoff.handoff_id,
        command_descriptor_id: input.descriptor.command_descriptor_id,
        executor_request_id: input.request.executor_request_id,
        output,
        receipt,
        status,
        blockers,
        provider_network_call_performed: input.command_succeeded,
        provider_write_executed: input.provider_write_executed,
        callback_effect_executed: input.callback_effect_executed,
        interruption_effect_executed: input.interruption_effect_executed,
        recovery_effect_executed: input.recovery_effect_executed,
        task_mutation_executed: input.task_mutation_executed,
        raw_provider_payload_retained: input.raw_provider_payload_retained,
    }
}

fn blockers(
    input: &ProviderLiveReadCommandResultMappingInput,
    output: &super::super::executor_types::ProviderLiveReadSanitizedRepositoryMetadataRecord,
    receipt: &super::super::executor_types::ProviderLiveReadServerReceiptRecord,
) -> Vec<ProviderLiveReadCommandResultMappingBlocker> {
    let mut blockers = Vec::new();
    if input.handoff.status != ProviderLiveReadCommandHandoffStatus::ReadyForReadOnlyCommand {
        blockers.push(ProviderLiveReadCommandResultMappingBlocker::HandoffNotReady);
    }
    if !input.command_succeeded {
        blockers.push(ProviderLiveReadCommandResultMappingBlocker::CommandFailed);
    }
    if output.status != ProviderLiveReadSanitizedRepositoryMetadataStatus::Sanitized {
        blockers.push(ProviderLiveReadCommandResultMappingBlocker::SanitizedOutputNotReady);
    }
    if receipt.status != ProviderLiveReadServerReceiptStatus::ProviderReadPerformed {
        blockers.push(ProviderLiveReadCommandResultMappingBlocker::ReceiptNotReady);
    }
    if input.provider_write_executed {
        blockers.push(ProviderLiveReadCommandResultMappingBlocker::ProviderWriteExecuted);
    }
    if input.callback_effect_executed {
        blockers.push(ProviderLiveReadCommandResultMappingBlocker::CallbackEffectExecuted);
    }
    if input.interruption_effect_executed {
        blockers.push(ProviderLiveReadCommandResultMappingBlocker::InterruptionEffectExecuted);
    }
    if input.recovery_effect_executed {
        blockers.push(ProviderLiveReadCommandResultMappingBlocker::RecoveryEffectExecuted);
    }
    if input.task_mutation_executed {
        blockers.push(ProviderLiveReadCommandResultMappingBlocker::TaskMutationExecuted);
    }
    if input.raw_provider_payload_retained {
        blockers.push(ProviderLiveReadCommandResultMappingBlocker::RawProviderPayloadRetained);
    }
    blockers
}

fn status(
    blockers: &[ProviderLiveReadCommandResultMappingBlocker],
    output: &super::super::executor_types::ProviderLiveReadSanitizedRepositoryMetadataRecord,
) -> ProviderLiveReadCommandResultMappingStatus {
    if blockers.is_empty() {
        ProviderLiveReadCommandResultMappingStatus::MappedSanitizedOutput
    } else if output.status == ProviderLiveReadSanitizedRepositoryMetadataStatus::ParseError {
        ProviderLiveReadCommandResultMappingStatus::ParseError
    } else {
        ProviderLiveReadCommandResultMappingStatus::Blocked
    }
}
