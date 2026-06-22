use crate::{
    forge_pull_request_refresh, persist_forge_pull_request_refreshes, ForgePullRequestProvider,
    ForgePullRequestRefreshInput, ForgePullRequestRefreshPersistenceInput,
    ForgePullRequestRefreshScope, ServerStateService,
};
use nucleus_local_store::{LocalStoreBackend, LocalStoreResult};

pub fn persist<B>(state: &ServerStateService<B>) -> LocalStoreResult<()>
where
    B: LocalStoreBackend,
{
    let refresh_set = forge_pull_request_refresh(ForgePullRequestRefreshInput {
        provider_context_refs: vec!["provider-context:github:repo".to_owned()],
        provider_instance_ref: Some("provider-instance:github:main".to_owned()),
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        remote_repo_ref: Some("remote-repo:owner/name".to_owned()),
        refresh_scope: Some(ForgePullRequestRefreshScope::AllOpen),
        credential_status_evidence_ref: Some("evidence:credential-status".to_owned()),
        repository_metadata_evidence_ref: Some("evidence:repo-metadata".to_owned()),
        pull_request_refresh_evidence_ref: Some("evidence:pull-request-refresh".to_owned()),
        sanitization_policy_ref: Some("sanitize:pull-request-refresh".to_owned()),
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
    persist_forge_pull_request_refreshes(
        state,
        ForgePullRequestRefreshPersistenceInput {
            refresh_set,
            evidence_refs: vec!["evidence:pull-request-refresh".to_owned()],
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
