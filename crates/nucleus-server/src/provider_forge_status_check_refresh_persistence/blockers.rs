use super::types::{
    ForgeStatusCheckRefreshPersistenceBlocker, ForgeStatusCheckRefreshPersistenceInput,
};

pub(super) fn persistence_blockers(
    input: &ForgeStatusCheckRefreshPersistenceInput,
) -> Vec<ForgeStatusCheckRefreshPersistenceBlocker> {
    let mut blockers = Vec::new();
    if input.evidence_refs.is_empty() {
        blockers.push(ForgeStatusCheckRefreshPersistenceBlocker::MissingEvidenceRef);
    }
    if input.credential_material_present {
        blockers.push(ForgeStatusCheckRefreshPersistenceBlocker::CredentialMaterialPresent);
    }
    if input.provider_payload_present {
        blockers.push(ForgeStatusCheckRefreshPersistenceBlocker::ProviderPayloadPresent);
    }
    if input.raw_provider_payload_retention_requested {
        blockers
            .push(ForgeStatusCheckRefreshPersistenceBlocker::RawProviderPayloadRetentionRequested);
    }
    if input.real_credential_resolution_requested {
        blockers.push(ForgeStatusCheckRefreshPersistenceBlocker::RealCredentialResolutionRequested);
    }
    if input.provider_network_call_requested {
        blockers.push(ForgeStatusCheckRefreshPersistenceBlocker::ProviderNetworkCallRequested);
    }
    if input.callback_execution_requested {
        blockers.push(ForgeStatusCheckRefreshPersistenceBlocker::CallbackExecutionRequested);
    }
    if input.interruption_execution_requested {
        blockers.push(ForgeStatusCheckRefreshPersistenceBlocker::InterruptionExecutionRequested);
    }
    if input.recovery_execution_requested {
        blockers.push(ForgeStatusCheckRefreshPersistenceBlocker::RecoveryExecutionRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ForgeStatusCheckRefreshPersistenceBlocker::TaskMutationRequested);
    }
    blockers
}
