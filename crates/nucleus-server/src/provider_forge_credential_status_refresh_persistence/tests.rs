mod support;

use super::*;
use crate::{
    ForgeCredentialStatusClass, ForgeCredentialStatusRefreshStatus, ForgeNetworkCredentialStatus,
    ServerStateService,
};
use nucleus_local_store::SqliteBackend;
use support::*;

#[test]
fn forge_credential_status_refresh_persistence_round_trips_sanitized_record() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));

    let set = persist_forge_credential_status_refreshes(
        &state,
        input(refresh_set(vec![credential(
            "credential:one",
            ForgeNetworkCredentialStatus::Ready,
        )])),
    )
    .expect("persist");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records = read_forge_credential_status_refreshes(&reopened).expect("read");

    assert_eq!(records, set.records);
    assert_eq!(records[0].credential_ref_id, "credential:one");
    assert_eq!(
        records[0].refresh_status,
        ForgeCredentialStatusRefreshStatus::ReadyForStoppedRefresh
    );
    assert!(!records[0].no_effects.credential_resolution_performed);
    assert!(!records[0].no_effects.provider_network_call_performed);
    assert!(!records[0].no_effects.raw_provider_payload_retained);
}

#[test]
fn forge_credential_status_refresh_persistence_represents_duplicate_and_repair() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let refresh_set = refresh_set(vec![credential(
        "credential:duplicate",
        ForgeNetworkCredentialStatus::RequiresUserAction,
    )]);

    let first = persist_forge_credential_status_refreshes(&state, input(refresh_set.clone()))
        .expect("persist first");
    let duplicate = persist_forge_credential_status_refreshes(
        &state,
        ForgeCredentialStatusRefreshPersistenceInput {
            existing_persisted_refresh_ids: vec![first.records[0].persisted_refresh_id.clone()],
            ..input(refresh_set)
        },
    )
    .expect("duplicate");

    assert_eq!(
        first.records[0].persistence_status,
        ForgeCredentialStatusRefreshPersistenceStatus::Persisted
    );
    assert_eq!(
        first.records[0].status_class,
        ForgeCredentialStatusClass::RequiresRepair
    );
    assert_eq!(
        duplicate.records[0].persistence_status,
        ForgeCredentialStatusRefreshPersistenceStatus::DuplicateNoop
    );
}

#[test]
fn forge_credential_status_refresh_persistence_blocks_raw_payloads_and_provider_work() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let mut input = input(refresh_set(vec![credential(
        "credential:blocked",
        ForgeNetworkCredentialStatus::Ready,
    )]));
    input.credential_material_present = true;
    input.provider_payload_present = true;
    input.raw_provider_payload_retention_requested = true;
    input.real_credential_resolution_requested = true;
    input.provider_network_call_requested = true;
    input.callback_execution_requested = true;
    input.interruption_execution_requested = true;
    input.recovery_execution_requested = true;
    input.task_mutation_requested = true;

    let set = persist_forge_credential_status_refreshes(&state, input).expect("blocked");
    let record = &set.records[0];

    assert_eq!(
        record.persistence_status,
        ForgeCredentialStatusRefreshPersistenceStatus::Blocked
    );
    assert!(record
        .persistence_blockers
        .contains(&ForgeCredentialStatusRefreshPersistenceBlocker::CredentialMaterialPresent));
    assert!(record
        .persistence_blockers
        .contains(&ForgeCredentialStatusRefreshPersistenceBlocker::ProviderNetworkCallRequested));
    assert!(!record.no_effects.provider_network_call_performed);
    assert!(!record.no_effects.task_mutation_executed);
}

#[test]
fn forge_credential_status_refresh_persistence_blocks_missing_evidence_refs() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let mut input = input(refresh_set(vec![credential(
        "credential:missing-evidence",
        ForgeNetworkCredentialStatus::Ready,
    )]));
    input.evidence_refs.clear();

    let set = persist_forge_credential_status_refreshes(&state, input).expect("blocked");

    assert_eq!(
        set.records[0].persistence_status,
        ForgeCredentialStatusRefreshPersistenceStatus::Blocked
    );
    assert!(set.records[0]
        .persistence_blockers
        .contains(&ForgeCredentialStatusRefreshPersistenceBlocker::MissingEvidenceRef));
}

#[test]
fn forge_credential_status_refresh_persistence_diagnostics_summarize_records() {
    let diagnostics = forge_credential_status_refresh_diagnostics_from_persisted_records(vec![
        persisted("one", ForgeCredentialStatusClass::Ready),
        persisted("two", ForgeCredentialStatusClass::RequiresRepair),
    ]);
    let dto = forge_credential_status_refresh_control_dto_from_diagnostics(diagnostics.clone());
    let json = serde_json::to_string(&dto).expect("serialize dto");

    assert_eq!(diagnostics.refresh_count, 2);
    assert_eq!(diagnostics.persisted_count, 2);
    assert_eq!(diagnostics.ready_credential_count, 1);
    assert_eq!(diagnostics.repair_credential_count, 1);
    assert_eq!(dto.refresh_count, 2);
    assert!(!dto.no_effects.credential_resolution_performed);
    assert!(!dto.no_effects.provider_network_call_performed);
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
}
