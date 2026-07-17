use crate::provider_no_effects::ProviderRuntimeNoEffects;
use crate::{
    ForgeCredentialStatusRefreshPersistenceRecord, ForgeNetworkExecutionOperationFamily,
    ForgePullRequestRefreshPersistenceRecord, ForgeRepositoryMetadataRefreshPersistenceRecord,
    ForgeStatusCheckRefreshPersistenceRecord,
};

use super::status_mapper::{
    credential_status, pull_request_status, repository_metadata_status, status_check_status,
};
use super::types::{ForgeReadIntentProjectionEntry, ForgeReadIntentProjectionFamily};

pub(super) fn credential_entry(
    record: ForgeCredentialStatusRefreshPersistenceRecord,
) -> ForgeReadIntentProjectionEntry {
    let status = credential_status(&record);
    ForgeReadIntentProjectionEntry {
        intent_id: format!("forge-read-intent:{}", record.persisted_refresh_id),
        source_persisted_refresh_id: record.persisted_refresh_id,
        family: ForgeReadIntentProjectionFamily::CredentialStatus,
        status,
        provider_context_ref: record.provider_context_ref,
        provider_instance_ref: None,
        forge_provider: None,
        remote_repo_ref: None,
        operation_family: record
            .allowed_operation_families
            .first()
            .cloned()
            .unwrap_or(ForgeNetworkExecutionOperationFamily::ProviderAuthStatusRefresh),
        blocker_count: record.refresh_blockers.len() + record.persistence_blockers.len(),
        evidence_ref_count: record.evidence_refs.len(),
        duplicate_refresh_detected: record.duplicate_refresh_detected,
        stopped_refresh_recorded: record.stopped_refresh_recorded,
        no_effects: ProviderRuntimeNoEffects::none(),
    }
}

pub(super) fn repository_metadata_entry(
    record: ForgeRepositoryMetadataRefreshPersistenceRecord,
) -> ForgeReadIntentProjectionEntry {
    let status = repository_metadata_status(&record);
    ForgeReadIntentProjectionEntry {
        intent_id: format!("forge-read-intent:{}", record.persisted_refresh_id),
        source_persisted_refresh_id: record.persisted_refresh_id,
        family: ForgeReadIntentProjectionFamily::RepositoryMetadata,
        status,
        provider_context_ref: Some(record.provider_context_ref),
        provider_instance_ref: record.provider_instance_ref,
        forge_provider: record.forge_provider,
        remote_repo_ref: record.remote_repo_ref,
        operation_family: record.operation_family,
        blocker_count: record.refresh_blockers.len() + record.persistence_blockers.len(),
        evidence_ref_count: record.evidence_refs.len(),
        duplicate_refresh_detected: record.duplicate_refresh_detected,
        stopped_refresh_recorded: record.stopped_refresh_recorded,
        no_effects: ProviderRuntimeNoEffects::none(),
    }
}

pub(super) fn pull_request_entry(
    record: ForgePullRequestRefreshPersistenceRecord,
) -> ForgeReadIntentProjectionEntry {
    let status = pull_request_status(&record);
    ForgeReadIntentProjectionEntry {
        intent_id: format!("forge-read-intent:{}", record.persisted_refresh_id),
        source_persisted_refresh_id: record.persisted_refresh_id,
        family: ForgeReadIntentProjectionFamily::PullRequest,
        status,
        provider_context_ref: Some(record.provider_context_ref),
        provider_instance_ref: record.provider_instance_ref,
        forge_provider: record.forge_provider,
        remote_repo_ref: record.remote_repo_ref,
        operation_family: record.operation_family,
        blocker_count: record.refresh_blockers.len() + record.persistence_blockers.len(),
        evidence_ref_count: record.evidence_refs.len(),
        duplicate_refresh_detected: record.duplicate_refresh_detected,
        stopped_refresh_recorded: record.stopped_refresh_recorded,
        no_effects: ProviderRuntimeNoEffects::none(),
    }
}

pub(super) fn status_check_entry(
    record: ForgeStatusCheckRefreshPersistenceRecord,
) -> ForgeReadIntentProjectionEntry {
    let status = status_check_status(&record);
    ForgeReadIntentProjectionEntry {
        intent_id: format!("forge-read-intent:{}", record.persisted_refresh_id),
        source_persisted_refresh_id: record.persisted_refresh_id,
        family: ForgeReadIntentProjectionFamily::StatusCheck,
        status,
        provider_context_ref: Some(record.provider_context_ref),
        provider_instance_ref: record.provider_instance_ref,
        forge_provider: record.forge_provider,
        remote_repo_ref: record.remote_repo_ref,
        operation_family: record.operation_family,
        blocker_count: record.refresh_blockers.len() + record.persistence_blockers.len(),
        evidence_ref_count: record.evidence_refs.len(),
        duplicate_refresh_detected: record.duplicate_refresh_detected,
        stopped_refresh_recorded: record.stopped_refresh_recorded,
        no_effects: ProviderRuntimeNoEffects::none(),
    }
}
