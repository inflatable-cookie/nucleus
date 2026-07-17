use crate::provider_no_effects::{ProviderNoEffects, ProviderRuntimeNoEffects};
use crate::{ForgePullRequestRefreshRecord, ForgePullRequestRefreshStatus};

use super::store::REFRESH_PREFIX;
use super::types::{
    ForgePullRequestRefreshPersistenceBlocker, ForgePullRequestRefreshPersistenceInput,
    ForgePullRequestRefreshPersistenceRecord, ForgePullRequestRefreshPersistenceStatus,
};

pub(super) fn persistence_record(
    input: &ForgePullRequestRefreshPersistenceInput,
    refresh: ForgePullRequestRefreshRecord,
    persisted_refresh_id: String,
    duplicate_refresh_detected: bool,
    persistence_blockers: Vec<ForgePullRequestRefreshPersistenceBlocker>,
) -> ForgePullRequestRefreshPersistenceRecord {
    let persistence_status = if duplicate_refresh_detected {
        ForgePullRequestRefreshPersistenceStatus::DuplicateNoop
    } else if persistence_blockers.is_empty() {
        ForgePullRequestRefreshPersistenceStatus::Persisted
    } else {
        ForgePullRequestRefreshPersistenceStatus::Blocked
    };
    let stopped_refresh_recorded = refresh.status
        == ForgePullRequestRefreshStatus::ReadyForStoppedRefresh
        && !duplicate_refresh_detected;

    ForgePullRequestRefreshPersistenceRecord {
        persisted_refresh_id,
        refresh_id: refresh.refresh_id,
        provider_context_ref: refresh.provider_context_ref,
        provider_instance_ref: refresh.provider_instance_ref,
        forge_provider: refresh.forge_provider,
        remote_repo_ref: refresh.remote_repo_ref,
        refresh_scope: refresh.refresh_scope,
        operation_family: refresh.operation_family,
        credential_status_evidence_ref: refresh.credential_status_evidence_ref,
        repository_metadata_evidence_ref: refresh.repository_metadata_evidence_ref,
        pull_request_refresh_evidence_ref: refresh.pull_request_refresh_evidence_ref,
        sanitization_policy_ref: refresh.sanitization_policy_ref,
        refresh_status: refresh.status,
        refresh_blockers: refresh.blockers,
        persistence_status,
        persistence_blockers,
        duplicate_refresh_detected,
        evidence_refs: unique_sorted(input.evidence_refs.clone()),
        stopped_refresh_recorded,
        no_effects: ProviderRuntimeNoEffects::none(),
    }
}

pub(super) fn persisted_refresh_id(refresh_id: &str) -> String {
    format!("{REFRESH_PREFIX}{refresh_id}")
}

fn unique_sorted(mut refs: Vec<String>) -> Vec<String> {
    refs.sort();
    refs.dedup();
    refs
}
