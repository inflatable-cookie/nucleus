use super::support::{persistence_input, ready_request_receipts};
use crate::{provider_live_read_admission::*, ServerStateService};
use nucleus_local_store::SqliteBackend;

#[test]
fn round_trips_sanitized_planned_record() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));

    let set = persist_provider_live_read_records(
        &state,
        persistence_input(ready_request_receipts(), false),
    )
    .expect("persist");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records = read_provider_live_read_records(&reopened).expect("read");

    assert_eq!(records, set.records);
    assert_eq!(
        records[0].persistence_status,
        ProviderLiveReadPersistenceStatus::Persisted
    );
    assert_eq!(
        records[0].request_status,
        ProviderLiveReadRequestReceiptStatus::PlannedRequestRecorded
    );
    assert_eq!(records[0].evidence_refs.len(), 12);
    assert!(!records[0].no_effects.credential_resolution_performed);
    assert!(!records[0].no_effects.provider_network_call_performed);
    assert!(!records[0].no_effects.provider_write_executed);
    assert!(!records[0].no_effects.raw_provider_payload_retained);
}

#[test]
fn represents_duplicate_noop() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let requests = ready_request_receipts();

    let first =
        persist_provider_live_read_records(&state, persistence_input(requests.clone(), false))
            .expect("first");
    let duplicate = persist_provider_live_read_records(
        &state,
        ProviderLiveReadPersistenceInput {
            existing_persisted_live_read_ids: vec![first.records[0].persisted_live_read_id.clone()],
            ..persistence_input(requests, false)
        },
    )
    .expect("duplicate");

    assert_eq!(
        first.records[0].persistence_status,
        ProviderLiveReadPersistenceStatus::Persisted
    );
    assert_eq!(
        duplicate.records[0].persistence_status,
        ProviderLiveReadPersistenceStatus::DuplicateNoop
    );
    assert!(duplicate.records[0].duplicate_live_read_detected);
    assert!(!duplicate.records[0].live_read_record_persisted);
}

#[test]
fn blocks_missing_evidence_and_unplanned_requests() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let mut input = persistence_input(ready_request_receipts(), false);
    input.persistence_evidence_refs.clear();
    input.request_receipts.records[0].status = ProviderLiveReadRequestReceiptStatus::RepairRequired;

    let set = persist_provider_live_read_records(&state, input).expect("blocked");
    let record = &set.records[0];

    assert_eq!(
        record.persistence_status,
        ProviderLiveReadPersistenceStatus::Blocked
    );
    assert!(record
        .persistence_blockers
        .contains(&ProviderLiveReadPersistenceBlocker::MissingPersistenceEvidenceRef));
    assert!(record
        .persistence_blockers
        .contains(&ProviderLiveReadPersistenceBlocker::RequestReceiptNotPlanned));
    assert!(!record.live_read_record_persisted);
}

#[test]
fn blocks_raw_payloads_and_provider_effects() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

    let set = persist_provider_live_read_records(
        &state,
        persistence_input(ready_request_receipts(), true),
    )
    .expect("blocked");
    let record = &set.records[0];

    assert_eq!(
        record.persistence_status,
        ProviderLiveReadPersistenceStatus::Blocked
    );
    assert!(record
        .persistence_blockers
        .contains(&ProviderLiveReadPersistenceBlocker::CredentialMaterialPresent));
    assert!(record
        .persistence_blockers
        .contains(&ProviderLiveReadPersistenceBlocker::ProviderNetworkCallRequested));
    assert!(record
        .persistence_blockers
        .contains(&ProviderLiveReadPersistenceBlocker::ProviderWriteRequested));
    assert!(record
        .persistence_blockers
        .contains(&ProviderLiveReadPersistenceBlocker::TaskMutationRequested));
    assert!(!record.no_effects.provider_network_call_performed);
    assert!(!record.no_effects.provider_write_executed);
    assert!(!record.no_effects.task_mutation_executed);
}

#[test]
fn diagnostics_serialize_sanitized_counts() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let persisted = persist_provider_live_read_records(
        &state,
        persistence_input(ready_request_receipts(), false),
    )
    .expect("persist");
    let duplicate = ProviderLiveReadPersistenceRecord {
        persistence_status: ProviderLiveReadPersistenceStatus::DuplicateNoop,
        duplicate_live_read_detected: true,
        live_read_record_persisted: false,
        ..persisted.records[0].clone()
    };

    let diagnostics = provider_live_read_persistence_diagnostics_from_records(vec![
        persisted.records[0].clone(),
        duplicate,
    ]);
    let dto = provider_live_read_persistence_control_dto_from_diagnostics(diagnostics.clone());
    let json = serde_json::to_string(&dto).expect("serialize dto");

    assert_eq!(diagnostics.live_read_count, 2);
    assert_eq!(diagnostics.persisted_count, 1);
    assert_eq!(diagnostics.duplicate_noop_count, 1);
    assert_eq!(diagnostics.planned_request_count, 2);
    assert_eq!(dto.live_read_count, 2);
    assert_eq!(dto.evidence_ref_count, 24);
    assert!(!dto.no_effects.credential_resolution_performed);
    assert!(!dto.no_effects.provider_network_call_performed);
    assert!(!dto.no_effects.provider_write_executed);
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
    assert!(!json.contains("provider_payload_bytes"));
    assert!(!json.contains("raw_request_body"));
    assert!(!json.contains("raw_response_body"));
}
