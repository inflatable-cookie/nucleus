use super::types::{
    ForgePullRequestRefreshPersistenceBlocker, ForgePullRequestRefreshPersistenceInput,
};

pub(super) fn persistence_blockers(
    input: &ForgePullRequestRefreshPersistenceInput,
) -> Vec<ForgePullRequestRefreshPersistenceBlocker> {
    let mut blockers = Vec::new();
    if input.evidence_refs.is_empty() {
        blockers.push(ForgePullRequestRefreshPersistenceBlocker::MissingEvidenceRef);
    }
    if input.credential_material_present {
        blockers.push(ForgePullRequestRefreshPersistenceBlocker::CredentialMaterialPresent);
    }
    if input.provider_payload_present {
        blockers.push(ForgePullRequestRefreshPersistenceBlocker::ProviderPayloadPresent);
    }
    if input.raw_provider_payload_retention_requested {
        blockers
            .push(ForgePullRequestRefreshPersistenceBlocker::RawProviderPayloadRetentionRequested);
    }
    if input.real_credential_resolution_requested {
        blockers.push(ForgePullRequestRefreshPersistenceBlocker::RealCredentialResolutionRequested);
    }
    if input.provider_network_call_requested {
        blockers.push(ForgePullRequestRefreshPersistenceBlocker::ProviderNetworkCallRequested);
    }
    if input.callback_execution_requested {
        blockers.push(ForgePullRequestRefreshPersistenceBlocker::CallbackExecutionRequested);
    }
    if input.interruption_execution_requested {
        blockers.push(ForgePullRequestRefreshPersistenceBlocker::InterruptionExecutionRequested);
    }
    if input.recovery_execution_requested {
        blockers.push(ForgePullRequestRefreshPersistenceBlocker::RecoveryExecutionRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ForgePullRequestRefreshPersistenceBlocker::TaskMutationRequested);
    }
    blockers
}
