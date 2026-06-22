use crate::{
    forge_credential_status_refresh, persist_forge_credential_status_refreshes,
    ForgeCredentialStatusRefreshInput, ForgeCredentialStatusRefreshPersistenceInput,
    ForgeNetworkCredentialKind, ForgeNetworkCredentialResolutionBoundary,
    ForgeNetworkCredentialStatus, ForgeNetworkExecutionCredentialRef,
    ForgeNetworkExecutionOperationFamily, ServerStateService,
};
use nucleus_local_store::{LocalStoreBackend, LocalStoreResult};

pub fn persist<B>(state: &ServerStateService<B>) -> LocalStoreResult<()>
where
    B: LocalStoreBackend,
{
    let refresh_set = forge_credential_status_refresh(ForgeCredentialStatusRefreshInput {
        credential_refs: vec![ForgeNetworkExecutionCredentialRef {
            credential_ref_id: "credential:github".to_owned(),
            credential_kind: ForgeNetworkCredentialKind::HostCredentialProvider,
            resolution_boundary: ForgeNetworkCredentialResolutionBoundary::HostCredentialProvider,
            status: ForgeNetworkCredentialStatus::Ready,
            allowed_operation_families: vec![
                ForgeNetworkExecutionOperationFamily::ProviderAuthStatusRefresh,
            ],
        }],
        provider_context_ref: Some("provider-context:github:repo".to_owned()),
        status_refresh_evidence_ref: Some("evidence:credential-status".to_owned()),
        sanitization_policy_ref: Some("sanitize:credential-status".to_owned()),
        credential_material_present: false,
        provider_payload_present: false,
        raw_provider_payload_retention_requested: false,
        real_credential_resolution_requested: false,
        provider_network_call_requested: false,
        callback_execution_requested: false,
        interruption_execution_requested: false,
        recovery_execution_requested: false,
        task_mutation_requested: false,
    });
    persist_forge_credential_status_refreshes(
        state,
        ForgeCredentialStatusRefreshPersistenceInput {
            refresh_set,
            evidence_refs: vec!["evidence:credential-status".to_owned()],
            existing_persisted_refresh_ids: Vec::new(),
            credential_material_present: false,
            provider_payload_present: false,
            raw_provider_payload_retention_requested: false,
            real_credential_resolution_requested: false,
            provider_network_call_requested: false,
            callback_execution_requested: false,
            interruption_execution_requested: false,
            recovery_execution_requested: false,
            task_mutation_requested: false,
        },
    )?;
    Ok(())
}
