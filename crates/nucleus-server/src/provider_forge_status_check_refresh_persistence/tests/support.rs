use crate::{
    forge_status_check_refresh, ForgeNetworkExecutionOperationFamily, ForgePullRequestProvider,
    ForgeStatusCheckRefreshInput, ForgeStatusCheckRefreshPersistenceInput,
    ForgeStatusCheckRefreshPersistenceRecord, ForgeStatusCheckRefreshPersistenceStatus,
    ForgeStatusCheckRefreshScope, ForgeStatusCheckRefreshSet, ForgeStatusCheckRefreshStatus,
};

pub fn input(refresh_set: ForgeStatusCheckRefreshSet) -> ForgeStatusCheckRefreshPersistenceInput {
    ForgeStatusCheckRefreshPersistenceInput {
        refresh_set,
        evidence_refs: vec!["evidence:status-check-refresh:planned".to_owned()],
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

pub fn refresh_set(provider_context_refs: Vec<String>) -> ForgeStatusCheckRefreshSet {
    forge_status_check_refresh(ForgeStatusCheckRefreshInput {
        provider_context_refs,
        provider_instance_ref: Some("provider-instance:github:main".to_owned()),
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        remote_repo_ref: Some("remote-repo:owner/name".to_owned()),
        refresh_scope: Some(ForgeStatusCheckRefreshScope::ChangeRequestRef(
            "change-request:github:42".to_owned(),
        )),
        credential_status_evidence_ref: Some("evidence:credential-status".to_owned()),
        repository_metadata_evidence_ref: Some("evidence:repo-metadata:persisted".to_owned()),
        status_check_refresh_evidence_ref: Some("evidence:status-check-refresh:planned".to_owned()),
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
    })
}

pub fn persisted(
    id: &str,
    persistence_status: ForgeStatusCheckRefreshPersistenceStatus,
) -> ForgeStatusCheckRefreshPersistenceRecord {
    ForgeStatusCheckRefreshPersistenceRecord {
        persisted_refresh_id: format!("persisted:{id}"),
        refresh_id: format!("refresh:{id}"),
        provider_context_ref: format!("provider-context:{id}"),
        provider_instance_ref: Some("provider-instance:github:main".to_owned()),
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        remote_repo_ref: Some("remote-repo:owner/name".to_owned()),
        refresh_scope: Some(ForgeStatusCheckRefreshScope::ChangeRequestRef(
            "change-request:github:42".to_owned(),
        )),
        operation_family: ForgeNetworkExecutionOperationFamily::StatusCheckRefresh,
        credential_status_evidence_ref: Some("evidence:credential-status".to_owned()),
        repository_metadata_evidence_ref: Some("evidence:repo-metadata:persisted".to_owned()),
        status_check_refresh_evidence_ref: Some("evidence:status-check-refresh:planned".to_owned()),
        sanitization_policy_ref: Some("sanitize:status-check-refresh".to_owned()),
        refresh_status: ForgeStatusCheckRefreshStatus::ReadyForStoppedRefresh,
        refresh_blockers: Vec::new(),
        persistence_status,
        persistence_blockers: Vec::new(),
        duplicate_refresh_detected: false,
        evidence_refs: vec!["evidence:status-check-refresh:planned".to_owned()],
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
