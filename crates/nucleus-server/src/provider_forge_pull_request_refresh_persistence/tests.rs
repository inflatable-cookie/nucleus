mod support;

use super::*;
use crate::{ForgePullRequestRefreshStatus, ServerStateService};
use nucleus_local_store::SqliteBackend;
use support::*;

#[test]
fn pull_request_refresh_persistence_round_trips_sanitized_record() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));

    let set = persist_forge_pull_request_refreshes(
        &state,
        input(refresh_set(vec!["provider-context:github:repo".to_owned()])),
    )
    .expect("persist");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records = read_forge_pull_request_refreshes(&reopened).expect("read");

    assert_eq!(records, set.records);
    assert_eq!(
        records[0].provider_context_ref,
        "provider-context:github:repo"
    );
    assert_eq!(
        records[0].refresh_status,
        ForgePullRequestRefreshStatus::ReadyForStoppedRefresh
    );
    assert!(!records[0].no_effects.credential_resolution_performed);
    assert!(!records[0].no_effects.provider_network_call_performed);
    assert!(!records[0].no_effects.raw_provider_payload_retained);
}

#[test]
fn pull_request_refresh_persistence_represents_duplicate_noop() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let refresh_set = refresh_set(vec!["provider-context:github:repo".to_owned()]);

    let first =
        persist_forge_pull_request_refreshes(&state, input(refresh_set.clone())).expect("first");
    let duplicate = persist_forge_pull_request_refreshes(
        &state,
        ForgePullRequestRefreshPersistenceInput {
            existing_persisted_refresh_ids: vec![first.records[0].persisted_refresh_id.clone()],
            ..input(refresh_set)
        },
    )
    .expect("duplicate");

    assert_eq!(
        first.records[0].persistence_status,
        ForgePullRequestRefreshPersistenceStatus::Persisted
    );
    assert_eq!(
        duplicate.records[0].persistence_status,
        ForgePullRequestRefreshPersistenceStatus::DuplicateNoop
    );
}

#[test]
fn pull_request_refresh_persistence_blocks_missing_evidence_refs() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let mut input = input(refresh_set(vec!["provider-context:github:repo".to_owned()]));
    input.evidence_refs.clear();

    let set = persist_forge_pull_request_refreshes(&state, input).expect("blocked");

    assert_eq!(
        set.records[0].persistence_status,
        ForgePullRequestRefreshPersistenceStatus::Blocked
    );
    assert!(set.records[0]
        .persistence_blockers
        .contains(&ForgePullRequestRefreshPersistenceBlocker::MissingEvidenceRef));
}

#[test]
fn pull_request_refresh_persistence_blocks_raw_payloads_and_provider_work() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let mut input = input(refresh_set(vec!["provider-context:github:repo".to_owned()]));
    input.credential_material_present = true;
    input.provider_payload_present = true;
    input.raw_provider_payload_retention_requested = true;
    input.real_credential_resolution_requested = true;
    input.provider_network_call_requested = true;
    input.callback_execution_requested = true;
    input.interruption_execution_requested = true;
    input.recovery_execution_requested = true;
    input.task_mutation_requested = true;

    let set = persist_forge_pull_request_refreshes(&state, input).expect("blocked");
    let record = &set.records[0];

    assert_eq!(
        record.persistence_status,
        ForgePullRequestRefreshPersistenceStatus::Blocked
    );
    assert!(record
        .persistence_blockers
        .contains(&ForgePullRequestRefreshPersistenceBlocker::ProviderNetworkCallRequested));
    assert!(record
        .persistence_blockers
        .contains(&ForgePullRequestRefreshPersistenceBlocker::CredentialMaterialPresent));
    assert!(!record.no_effects.provider_effect_executed);
    assert!(!record.no_effects.task_mutation_executed);
}

#[test]
fn pull_request_refresh_persistence_diagnostics_summarize_records() {
    let diagnostics = forge_pull_request_refresh_diagnostics_from_persisted_records(vec![
        persisted("one", ForgePullRequestRefreshPersistenceStatus::Persisted),
        persisted(
            "two",
            ForgePullRequestRefreshPersistenceStatus::DuplicateNoop,
        ),
    ]);
    let dto = forge_pull_request_refresh_control_dto_from_diagnostics(diagnostics.clone());
    let json = serde_json::to_string(&dto).expect("serialize dto");

    assert_eq!(diagnostics.refresh_count, 2);
    assert_eq!(diagnostics.persisted_count, 1);
    assert_eq!(diagnostics.duplicate_noop_count, 1);
    assert_eq!(dto.refresh_count, 2);
    assert!(!dto.no_effects.credential_resolution_performed);
    assert!(!dto.no_effects.provider_network_call_performed);
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
}
