use crate::{
    ForgeCredentialStatusClass, ForgeCredentialStatusRefreshBlocker,
    ForgeCredentialStatusRefreshPersistenceRecord, ForgeCredentialStatusRefreshPersistenceStatus,
    ForgeCredentialStatusRefreshStatus, ForgeNetworkCredentialKind,
    ForgeNetworkCredentialResolutionBoundary, ForgeNetworkCredentialStatus,
    ForgeNetworkExecutionOperationFamily, ForgePullRequestProvider,
    ForgePullRequestRefreshPersistenceRecord, ForgePullRequestRefreshPersistenceStatus,
    ForgePullRequestRefreshScope, ForgePullRequestRefreshStatus,
    ForgeRepositoryMetadataRefreshPersistenceRecord,
    ForgeRepositoryMetadataRefreshPersistenceStatus, ForgeRepositoryMetadataRefreshStatus,
};

pub fn credential(
    id: &str,
    persistence_status: ForgeCredentialStatusRefreshPersistenceStatus,
) -> ForgeCredentialStatusRefreshPersistenceRecord {
    ForgeCredentialStatusRefreshPersistenceRecord {
        persisted_refresh_id: format!("persisted:credential:{id}"),
        refresh_id: format!("refresh:credential:{id}"),
        credential_ref_id: format!("credential:{id}"),
        credential_kind: ForgeNetworkCredentialKind::HostCredentialProvider,
        resolution_boundary: ForgeNetworkCredentialResolutionBoundary::HostCredentialProvider,
        current_status: ForgeNetworkCredentialStatus::Ready,
        status_class: ForgeCredentialStatusClass::Ready,
        allowed_operation_families: vec![
            ForgeNetworkExecutionOperationFamily::ProviderAuthStatusRefresh,
        ],
        provider_context_ref: Some("provider-context:github:repo".to_owned()),
        status_refresh_evidence_ref: Some("evidence:credential-status".to_owned()),
        sanitization_policy_ref: Some("sanitize:credential-status".to_owned()),
        refresh_status: ForgeCredentialStatusRefreshStatus::ReadyForStoppedRefresh,
        refresh_blockers: Vec::<ForgeCredentialStatusRefreshBlocker>::new(),
        persistence_status,
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

pub fn repository(
    id: &str,
    persistence_status: ForgeRepositoryMetadataRefreshPersistenceStatus,
) -> ForgeRepositoryMetadataRefreshPersistenceRecord {
    ForgeRepositoryMetadataRefreshPersistenceRecord {
        persisted_refresh_id: format!("persisted:repository:{id}"),
        refresh_id: format!("refresh:repository:{id}"),
        provider_context_ref: format!("provider-context:{id}"),
        provider_instance_ref: Some("provider-instance:github:main".to_owned()),
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        remote_repo_ref: Some("remote-repo:owner/name".to_owned()),
        operation_family: ForgeNetworkExecutionOperationFamily::RepositoryMetadataRefresh,
        credential_status_evidence_ref: Some("evidence:credential-status".to_owned()),
        repository_metadata_evidence_ref: Some("evidence:repo-metadata".to_owned()),
        sanitization_policy_ref: Some("sanitize:repository-metadata".to_owned()),
        refresh_status: ForgeRepositoryMetadataRefreshStatus::ReadyForStoppedRefresh,
        refresh_blockers: Vec::new(),
        persistence_status,
        persistence_blockers: Vec::new(),
        duplicate_refresh_detected: false,
        evidence_refs: vec!["evidence:repo-metadata".to_owned()],
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

pub fn pull_request(
    id: &str,
    persistence_status: ForgePullRequestRefreshPersistenceStatus,
) -> ForgePullRequestRefreshPersistenceRecord {
    let duplicate_refresh_detected = matches!(
        persistence_status,
        ForgePullRequestRefreshPersistenceStatus::DuplicateNoop
    );
    ForgePullRequestRefreshPersistenceRecord {
        persisted_refresh_id: format!("persisted:pull-request:{id}"),
        refresh_id: format!("refresh:pull-request:{id}"),
        provider_context_ref: format!("provider-context:{id}"),
        provider_instance_ref: Some("provider-instance:github:main".to_owned()),
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        remote_repo_ref: Some("remote-repo:owner/name".to_owned()),
        refresh_scope: Some(ForgePullRequestRefreshScope::AllOpen),
        operation_family: ForgeNetworkExecutionOperationFamily::PullRequestRefresh,
        credential_status_evidence_ref: Some("evidence:credential-status".to_owned()),
        repository_metadata_evidence_ref: Some("evidence:repo-metadata".to_owned()),
        pull_request_refresh_evidence_ref: Some("evidence:pull-request-refresh".to_owned()),
        sanitization_policy_ref: Some("sanitize:pull-request-refresh".to_owned()),
        refresh_status: ForgePullRequestRefreshStatus::ReadyForStoppedRefresh,
        refresh_blockers: Vec::new(),
        persistence_status,
        persistence_blockers: Vec::new(),
        duplicate_refresh_detected,
        evidence_refs: vec!["evidence:pull-request-refresh".to_owned()],
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
