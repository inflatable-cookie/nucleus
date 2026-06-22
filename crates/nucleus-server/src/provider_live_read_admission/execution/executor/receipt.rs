use super::super::executor_types::{
    ProviderLiveReadGhCommandDescriptorStatus, ProviderLiveReadSanitizedRepositoryMetadataStatus,
    ProviderLiveReadServerReceiptBlocker, ProviderLiveReadServerReceiptInput,
    ProviderLiveReadServerReceiptRecord, ProviderLiveReadServerReceiptStatus,
    ProviderLiveReadServerRequestStatus,
};

pub fn provider_live_read_server_receipt(
    input: ProviderLiveReadServerReceiptInput,
) -> ProviderLiveReadServerReceiptRecord {
    let blockers = receipt_blockers(&input);
    let status = if blockers.is_empty() {
        ProviderLiveReadServerReceiptStatus::ProviderReadPerformed
    } else {
        ProviderLiveReadServerReceiptStatus::Blocked
    };

    ProviderLiveReadServerReceiptRecord {
        receipt_id: format!(
            "provider-live-read-server-receipt:{}",
            input.request.executor_request_id
        ),
        executor_request_id: input.request.executor_request_id,
        command_descriptor_id: input.descriptor.command_descriptor_id,
        output_record_id: input.output.output_record_id,
        provider_exit_code: input.provider_exit_code,
        receipt_evidence_ref: input.receipt_evidence_ref,
        status,
        blockers,
        provider_network_call_performed: input.provider_network_call_performed,
        provider_write_executed: input.provider_write_executed,
        callback_effect_executed: input.callback_effect_executed,
        interruption_effect_executed: input.interruption_effect_executed,
        recovery_effect_executed: input.recovery_effect_executed,
        task_mutation_executed: input.task_mutation_executed,
        raw_provider_payload_retained: input.raw_provider_payload_retained,
    }
}

fn receipt_blockers(
    input: &ProviderLiveReadServerReceiptInput,
) -> Vec<ProviderLiveReadServerReceiptBlocker> {
    let mut blockers = Vec::new();
    if input.request.status != ProviderLiveReadServerRequestStatus::ReadyForCommandDescriptor {
        blockers.push(ProviderLiveReadServerReceiptBlocker::ExecutorRequestNotReady);
    }
    if input.descriptor.status != ProviderLiveReadGhCommandDescriptorStatus::ReadyForReadOnlySpawn {
        blockers.push(ProviderLiveReadServerReceiptBlocker::CommandDescriptorNotReady);
    }
    if input.output.status != ProviderLiveReadSanitizedRepositoryMetadataStatus::Sanitized {
        blockers.push(ProviderLiveReadServerReceiptBlocker::SanitizedOutputNotReady);
    }
    if !input.provider_network_call_performed {
        blockers.push(ProviderLiveReadServerReceiptBlocker::ProviderNetworkReadNotPerformed);
    }
    if input.provider_write_executed {
        blockers.push(ProviderLiveReadServerReceiptBlocker::ProviderWriteExecuted);
    }
    if input.callback_effect_executed {
        blockers.push(ProviderLiveReadServerReceiptBlocker::CallbackEffectExecuted);
    }
    if input.interruption_effect_executed {
        blockers.push(ProviderLiveReadServerReceiptBlocker::InterruptionEffectExecuted);
    }
    if input.recovery_effect_executed {
        blockers.push(ProviderLiveReadServerReceiptBlocker::RecoveryEffectExecuted);
    }
    if input.task_mutation_executed {
        blockers.push(ProviderLiveReadServerReceiptBlocker::TaskMutationExecuted);
    }
    if input.raw_provider_payload_retained {
        blockers.push(ProviderLiveReadServerReceiptBlocker::RawProviderPayloadRetained);
    }
    blockers
}
