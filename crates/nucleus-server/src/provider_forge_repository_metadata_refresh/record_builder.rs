use crate::provider_no_effects::{ProviderNoEffects, ProviderRuntimeNoEffects};
use super::types::{
    ForgeRepositoryMetadataRefreshBlocker, ForgeRepositoryMetadataRefreshInput,
    ForgeRepositoryMetadataRefreshRecord, ForgeRepositoryMetadataRefreshStatus,
};
use crate::ForgeNetworkExecutionOperationFamily;

pub(super) fn refresh_record(
    input: &ForgeRepositoryMetadataRefreshInput,
    provider_context_ref: String,
) -> ForgeRepositoryMetadataRefreshRecord {
    let blockers = blockers(input, &provider_context_ref);
    let status = status(&blockers);

    ForgeRepositoryMetadataRefreshRecord {
        refresh_id: format!("forge-repository-metadata-refresh:{provider_context_ref}"),
        provider_context_ref,
        provider_instance_ref: input.provider_instance_ref.clone(),
        forge_provider: input.forge_provider.clone(),
        remote_repo_ref: input.remote_repo_ref.clone(),
        operation_family: ForgeNetworkExecutionOperationFamily::RepositoryMetadataRefresh,
        credential_status_evidence_ref: input.credential_status_evidence_ref.clone(),
        repository_metadata_evidence_ref: input.repository_metadata_evidence_ref.clone(),
        sanitization_policy_ref: input.sanitization_policy_ref.clone(),
        stopped_refresh_recorded: status
            == ForgeRepositoryMetadataRefreshStatus::ReadyForStoppedRefresh,
        status,
        blockers,
        no_effects: ProviderRuntimeNoEffects::none(),
    }
}

fn blockers(
    input: &ForgeRepositoryMetadataRefreshInput,
    provider_context_ref: &str,
) -> Vec<ForgeRepositoryMetadataRefreshBlocker> {
    let mut blockers = Vec::new();
    if provider_context_ref.is_empty() {
        blockers.push(ForgeRepositoryMetadataRefreshBlocker::EmptyProviderContextRef);
    }
    required_ref_blockers(input, &mut blockers);
    forbidden_blockers(input, &mut blockers);
    blockers
}

fn required_ref_blockers(
    input: &ForgeRepositoryMetadataRefreshInput,
    blockers: &mut Vec<ForgeRepositoryMetadataRefreshBlocker>,
) {
    if input
        .provider_instance_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(ForgeRepositoryMetadataRefreshBlocker::MissingProviderInstanceRef);
    }
    if input.forge_provider.is_none() {
        blockers.push(ForgeRepositoryMetadataRefreshBlocker::MissingForgeProvider);
    }
    if input
        .remote_repo_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(ForgeRepositoryMetadataRefreshBlocker::MissingRemoteRepoRef);
    }
    if input
        .credential_status_evidence_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(ForgeRepositoryMetadataRefreshBlocker::MissingCredentialStatusEvidenceRef);
    }
    if input
        .repository_metadata_evidence_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(ForgeRepositoryMetadataRefreshBlocker::MissingRepositoryMetadataEvidenceRef);
    }
    if input
        .sanitization_policy_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(ForgeRepositoryMetadataRefreshBlocker::MissingSanitizationPolicyRef);
    }
}

fn forbidden_blockers(
    input: &ForgeRepositoryMetadataRefreshInput,
    blockers: &mut Vec<ForgeRepositoryMetadataRefreshBlocker>,
) {
    if input.credential_material_present {
        blockers.push(ForgeRepositoryMetadataRefreshBlocker::CredentialMaterialPresent);
    }
    if input.provider_payload_present {
        blockers.push(ForgeRepositoryMetadataRefreshBlocker::ProviderPayloadPresent);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(ForgeRepositoryMetadataRefreshBlocker::RawProviderPayloadRetentionRequested);
    }
    if input.real_credential_resolution_requested {
        blockers.push(ForgeRepositoryMetadataRefreshBlocker::RealCredentialResolutionRequested);
    }
    if input.provider_network_call_requested {
        blockers.push(ForgeRepositoryMetadataRefreshBlocker::ProviderNetworkCallRequested);
    }
    if input.callback_execution_requested {
        blockers.push(ForgeRepositoryMetadataRefreshBlocker::CallbackExecutionRequested);
    }
    if input.interruption_execution_requested {
        blockers.push(ForgeRepositoryMetadataRefreshBlocker::InterruptionExecutionRequested);
    }
    if input.recovery_execution_requested {
        blockers.push(ForgeRepositoryMetadataRefreshBlocker::RecoveryExecutionRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ForgeRepositoryMetadataRefreshBlocker::TaskMutationRequested);
    }
}

fn status(
    blockers: &[ForgeRepositoryMetadataRefreshBlocker],
) -> ForgeRepositoryMetadataRefreshStatus {
    if blockers.is_empty() {
        ForgeRepositoryMetadataRefreshStatus::ReadyForStoppedRefresh
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ForgeRepositoryMetadataRefreshBlocker::EmptyProviderContextRef
                | ForgeRepositoryMetadataRefreshBlocker::MissingProviderInstanceRef
                | ForgeRepositoryMetadataRefreshBlocker::MissingForgeProvider
                | ForgeRepositoryMetadataRefreshBlocker::MissingRemoteRepoRef
                | ForgeRepositoryMetadataRefreshBlocker::MissingCredentialStatusEvidenceRef
                | ForgeRepositoryMetadataRefreshBlocker::MissingRepositoryMetadataEvidenceRef
                | ForgeRepositoryMetadataRefreshBlocker::MissingSanitizationPolicyRef
        )
    }) {
        ForgeRepositoryMetadataRefreshStatus::RepairRequired
    } else {
        ForgeRepositoryMetadataRefreshStatus::Blocked
    }
}
