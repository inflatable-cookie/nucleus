use crate::{
    forge_status_check_refresh, persist_forge_status_check_refreshes, ForgePullRequestProvider,
    ForgeStatusCheckRefreshInput, ForgeStatusCheckRefreshPersistenceInput,
    ForgeStatusCheckRefreshScope, ServerStateService,
};
use nucleus_local_store::{LocalStoreBackend, LocalStoreResult};

pub fn persist<B>(state: &ServerStateService<B>) -> LocalStoreResult<()>
where
    B: LocalStoreBackend,
{
    let refresh_set = forge_status_check_refresh(ForgeStatusCheckRefreshInput {
        provider_context_refs: vec!["provider-context:github:repo".to_owned()],
        provider_instance_ref: Some("provider-instance:github:main".to_owned()),
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        remote_repo_ref: Some("remote-repo:owner/name".to_owned()),
        refresh_scope: Some(ForgeStatusCheckRefreshScope::ChangeRequestRef(
            "change-request:1".to_owned(),
        )),
        credential_status_evidence_ref: Some("evidence:credential-status".to_owned()),
        repository_metadata_evidence_ref: Some("evidence:repo-metadata".to_owned()),
        status_check_refresh_evidence_ref: Some("evidence:status-check-refresh".to_owned()),
        sanitization_policy_ref: Some("sanitize:status-check-refresh".to_owned()),
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
    persist_forge_status_check_refreshes(
        state,
        ForgeStatusCheckRefreshPersistenceInput {
            refresh_set,
            evidence_refs: vec!["evidence:status-check-refresh".to_owned()],
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
