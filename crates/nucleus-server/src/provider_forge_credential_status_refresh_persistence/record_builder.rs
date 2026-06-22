use crate::{ForgeCredentialStatusRefreshRecord, ForgeCredentialStatusRefreshStatus};

use super::store::REFRESH_PREFIX;
use super::types::{
    ForgeCredentialStatusRefreshPersistenceBlocker, ForgeCredentialStatusRefreshPersistenceInput,
    ForgeCredentialStatusRefreshPersistenceRecord, ForgeCredentialStatusRefreshPersistenceStatus,
};

pub(super) fn persistence_record(
    input: &ForgeCredentialStatusRefreshPersistenceInput,
    refresh: ForgeCredentialStatusRefreshRecord,
    persisted_refresh_id: String,
    duplicate_refresh_detected: bool,
    persistence_blockers: Vec<ForgeCredentialStatusRefreshPersistenceBlocker>,
) -> ForgeCredentialStatusRefreshPersistenceRecord {
    let persistence_status = if duplicate_refresh_detected {
        ForgeCredentialStatusRefreshPersistenceStatus::DuplicateNoop
    } else if persistence_blockers.is_empty() {
        ForgeCredentialStatusRefreshPersistenceStatus::Persisted
    } else {
        ForgeCredentialStatusRefreshPersistenceStatus::Blocked
    };
    let stopped_refresh_recorded = refresh.status
        == ForgeCredentialStatusRefreshStatus::ReadyForStoppedRefresh
        && !duplicate_refresh_detected;

    ForgeCredentialStatusRefreshPersistenceRecord {
        persisted_refresh_id,
        refresh_id: refresh.refresh_id,
        credential_ref_id: refresh.credential_ref_id,
        credential_kind: refresh.credential_kind,
        resolution_boundary: refresh.resolution_boundary,
        current_status: refresh.current_status,
        status_class: refresh.status_class,
        allowed_operation_families: refresh.allowed_operation_families,
        provider_context_ref: refresh.provider_context_ref,
        status_refresh_evidence_ref: refresh.status_refresh_evidence_ref,
        sanitization_policy_ref: refresh.sanitization_policy_ref,
        refresh_status: refresh.status,
        refresh_blockers: refresh.blockers,
        persistence_status,
        persistence_blockers,
        duplicate_refresh_detected,
        evidence_refs: unique_sorted(input.evidence_refs.clone()),
        stopped_refresh_recorded,
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

pub(super) fn persisted_refresh_id(refresh_id: &str) -> String {
    format!("{REFRESH_PREFIX}{refresh_id}")
}

fn unique_sorted(mut refs: Vec<String>) -> Vec<String> {
    refs.sort();
    refs.dedup();
    refs
}
