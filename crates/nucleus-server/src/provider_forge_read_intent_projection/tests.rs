mod support;

use super::*;
use crate::{
    ForgeCredentialStatusRefreshPersistenceStatus, ForgePullRequestRefreshPersistenceStatus,
    ForgeRepositoryMetadataRefreshBlocker, ForgeStatusCheckRefreshPersistenceStatus,
};
use support::*;

#[test]
fn read_intent_projection_groups_persisted_refresh_families() {
    let set = forge_read_intent_projection(ForgeReadIntentProjectionInput {
        credential_status_records: vec![credential("credential", credential_persisted())],
        repository_metadata_records: vec![repository("repo", repository_persisted())],
        pull_request_records: vec![pull_request("pr", pull_request_persisted())],
        status_check_records: vec![status_check("check", status_check_persisted())],
    });

    assert_eq!(set.total_count, 4);
    assert_eq!(set.credential_status_count, 1);
    assert_eq!(set.repository_metadata_count, 1);
    assert_eq!(set.pull_request_count, 1);
    assert_eq!(set.status_check_count, 1);
    assert_eq!(set.ready_count, 4);
    assert_eq!(set.blocked_count, 0);
    assert!(set
        .entries
        .iter()
        .any(|entry| entry.family == ForgeReadIntentProjectionFamily::PullRequest));
    assert!(set
        .entries
        .iter()
        .any(|entry| entry.family == ForgeReadIntentProjectionFamily::StatusCheck));
    assert!(!set.provider_network_call_performed);
    assert!(!set.credential_resolution_performed);
}

#[test]
fn read_intent_projection_counts_duplicate_blocked_and_repair_states() {
    let mut repair = repository("repair", repository_persisted());
    repair
        .refresh_blockers
        .push(ForgeRepositoryMetadataRefreshBlocker::MissingRemoteRepoRef);
    let duplicate = pull_request(
        "duplicate",
        ForgePullRequestRefreshPersistenceStatus::DuplicateNoop,
    );
    let blocked = credential(
        "blocked",
        ForgeCredentialStatusRefreshPersistenceStatus::Blocked,
    );

    let set = forge_read_intent_projection(ForgeReadIntentProjectionInput {
        credential_status_records: vec![blocked],
        repository_metadata_records: vec![repair],
        pull_request_records: vec![duplicate],
        status_check_records: Vec::new(),
    });

    assert_eq!(set.total_count, 3);
    assert_eq!(set.ready_count, 0);
    assert_eq!(set.repair_required_count, 1);
    assert_eq!(set.duplicate_noop_count, 1);
    assert_eq!(set.blocked_count, 1);
    assert_eq!(set.blocker_count, 1);
}

#[test]
fn read_intent_projection_control_dto_serializes_sanitized_counts() {
    let set = forge_read_intent_projection(ForgeReadIntentProjectionInput {
        credential_status_records: vec![credential("credential", credential_persisted())],
        repository_metadata_records: vec![repository("repo", repository_persisted())],
        pull_request_records: vec![pull_request("pr", pull_request_persisted())],
        status_check_records: vec![status_check("check", status_check_persisted())],
    });
    let dto = forge_read_intent_projection_control_dto(&set);
    let json = serde_json::to_string(&dto).expect("serialize dto");

    assert_eq!(dto.total_count, 4);
    assert_eq!(dto.ready_count, 4);
    assert_eq!(dto.status_check_count, 1);
    assert_eq!(dto.evidence_ref_count, 4);
    assert!(!dto.provider_effect_executed);
    assert!(!dto.raw_provider_payload_retained);
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
}

fn credential_persisted() -> ForgeCredentialStatusRefreshPersistenceStatus {
    ForgeCredentialStatusRefreshPersistenceStatus::Persisted
}

fn repository_persisted() -> crate::ForgeRepositoryMetadataRefreshPersistenceStatus {
    crate::ForgeRepositoryMetadataRefreshPersistenceStatus::Persisted
}

fn pull_request_persisted() -> ForgePullRequestRefreshPersistenceStatus {
    ForgePullRequestRefreshPersistenceStatus::Persisted
}

fn status_check_persisted() -> ForgeStatusCheckRefreshPersistenceStatus {
    ForgeStatusCheckRefreshPersistenceStatus::Persisted
}
