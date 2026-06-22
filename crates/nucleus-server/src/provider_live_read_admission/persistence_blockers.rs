use super::{
    ProviderLiveReadPersistenceBlocker, ProviderLiveReadPersistenceInput,
    ProviderLiveReadRequestReceiptRecord, ProviderLiveReadRequestReceiptStatus,
};

pub(super) fn persistence_blockers(
    input: &ProviderLiveReadPersistenceInput,
    request: &ProviderLiveReadRequestReceiptRecord,
) -> Vec<ProviderLiveReadPersistenceBlocker> {
    let mut blockers = Vec::new();

    if request.status != ProviderLiveReadRequestReceiptStatus::PlannedRequestRecorded {
        blockers.push(ProviderLiveReadPersistenceBlocker::RequestReceiptNotPlanned);
    }
    if input.persistence_evidence_refs.is_empty() {
        blockers.push(ProviderLiveReadPersistenceBlocker::MissingPersistenceEvidenceRef);
    }
    if input.credential_material_present {
        blockers.push(ProviderLiveReadPersistenceBlocker::CredentialMaterialPresent);
    }
    if input.provider_payload_present {
        blockers.push(ProviderLiveReadPersistenceBlocker::ProviderPayloadPresent);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(ProviderLiveReadPersistenceBlocker::RawProviderPayloadRetentionRequested);
    }
    if input.real_credential_resolution_requested {
        blockers.push(ProviderLiveReadPersistenceBlocker::RealCredentialResolutionRequested);
    }
    if input.provider_network_call_requested {
        blockers.push(ProviderLiveReadPersistenceBlocker::ProviderNetworkCallRequested);
    }
    if input.provider_write_requested {
        blockers.push(ProviderLiveReadPersistenceBlocker::ProviderWriteRequested);
    }
    if input.callback_execution_requested {
        blockers.push(ProviderLiveReadPersistenceBlocker::CallbackExecutionRequested);
    }
    if input.interruption_execution_requested {
        blockers.push(ProviderLiveReadPersistenceBlocker::InterruptionExecutionRequested);
    }
    if input.recovery_execution_requested {
        blockers.push(ProviderLiveReadPersistenceBlocker::RecoveryExecutionRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ProviderLiveReadPersistenceBlocker::TaskMutationRequested);
    }

    blockers
}
