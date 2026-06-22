use crate::{
    forge_credential_status_refresh, ForgeCredentialStatusClass, ForgeCredentialStatusRefreshInput,
    ForgeCredentialStatusRefreshPersistenceInput, ForgeCredentialStatusRefreshPersistenceRecord,
    ForgeCredentialStatusRefreshPersistenceStatus, ForgeCredentialStatusRefreshSet,
    ForgeCredentialStatusRefreshStatus, ForgeNetworkCredentialKind,
    ForgeNetworkCredentialResolutionBoundary, ForgeNetworkCredentialStatus,
    ForgeNetworkExecutionCredentialRef, ForgeNetworkExecutionOperationFamily,
};

pub fn input(
    refresh_set: ForgeCredentialStatusRefreshSet,
) -> ForgeCredentialStatusRefreshPersistenceInput {
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
    }
}

pub fn refresh_set(
    credentials: Vec<ForgeNetworkExecutionCredentialRef>,
) -> ForgeCredentialStatusRefreshSet {
    forge_credential_status_refresh(ForgeCredentialStatusRefreshInput {
        credential_refs: credentials,
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
    })
}

pub fn credential(
    id: &str,
    status: ForgeNetworkCredentialStatus,
) -> ForgeNetworkExecutionCredentialRef {
    ForgeNetworkExecutionCredentialRef {
        credential_ref_id: id.to_owned(),
        credential_kind: ForgeNetworkCredentialKind::HostCredentialProvider,
        resolution_boundary: ForgeNetworkCredentialResolutionBoundary::HostCredentialProvider,
        status,
        allowed_operation_families: vec![
            ForgeNetworkExecutionOperationFamily::ProviderAuthStatusRefresh,
        ],
    }
}

pub fn persisted(
    id: &str,
    status_class: ForgeCredentialStatusClass,
) -> ForgeCredentialStatusRefreshPersistenceRecord {
    ForgeCredentialStatusRefreshPersistenceRecord {
        persisted_refresh_id: format!("persisted:{id}"),
        refresh_id: format!("refresh:{id}"),
        credential_ref_id: format!("credential:{id}"),
        credential_kind: ForgeNetworkCredentialKind::HostCredentialProvider,
        resolution_boundary: ForgeNetworkCredentialResolutionBoundary::HostCredentialProvider,
        current_status: ForgeNetworkCredentialStatus::Ready,
        status_class,
        allowed_operation_families: vec![
            ForgeNetworkExecutionOperationFamily::ProviderAuthStatusRefresh,
        ],
        provider_context_ref: Some("provider-context:github:repo".to_owned()),
        status_refresh_evidence_ref: Some("evidence:credential-status".to_owned()),
        sanitization_policy_ref: Some("sanitize:credential-status".to_owned()),
        refresh_status: ForgeCredentialStatusRefreshStatus::ReadyForStoppedRefresh,
        refresh_blockers: Vec::new(),
        persistence_status: ForgeCredentialStatusRefreshPersistenceStatus::Persisted,
        persistence_blockers: Vec::new(),
        duplicate_refresh_detected: false,
        evidence_refs: vec!["evidence:credential-status".to_owned()],
        stopped_refresh_recorded: true,
        credential_resolution_performed: false,
        provider_network_call_performed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}
