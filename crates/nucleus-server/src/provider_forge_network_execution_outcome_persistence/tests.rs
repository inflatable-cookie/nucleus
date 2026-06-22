mod support;

use super::*;
use crate::{ForgeNetworkExecutionRequestReceiptStatus, ServerStateService};
use nucleus_local_store::SqliteBackend;
use support::*;

#[test]
fn forge_network_execution_outcomes_round_trip_sanitized_record() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));

    let set = persist_forge_network_execution_outcomes(
        &state,
        input(
            request_receipt_set(vec![request_receipt("1", ready())]),
            stopped(),
            false,
        ),
    )
    .expect("persist");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records = read_forge_network_execution_outcomes(&reopened).expect("read");

    assert_eq!(records, set.records);
    assert_eq!(records[0].outcome_status, stopped());
    assert_eq!(
        records[0].provider_response_evidence_ref.as_deref(),
        Some("provider-response-evidence:planned")
    );
    assert!(!records[0].provider_network_call_performed);
    assert!(!records[0].credential_resolution_performed);
    assert!(!records[0].raw_provider_payload_retained);
}

#[test]
fn forge_network_execution_outcomes_represent_blocked_repair_and_duplicate() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

    let failed = persist_forge_network_execution_outcomes(
        &state,
        input(
            request_receipt_set(vec![request_receipt("failed", ready())]),
            failed(),
            false,
        ),
    )
    .expect("failed");
    let mixed = persist_forge_network_execution_outcomes(
        &state,
        input(
            request_receipt_set(vec![
                request_receipt("blocked", blocked()),
                request_receipt("repair", repair_required()),
            ]),
            stopped(),
            false,
        ),
    )
    .expect("mixed");
    let duplicate = persist_forge_network_execution_outcomes(
        &state,
        ForgeNetworkExecutionOutcomePersistenceInput {
            existing_outcome_ids: vec![failed.records[0].persisted_outcome_id.clone()],
            ..input(
                request_receipt_set(vec![request_receipt("failed", ready())]),
                stopped(),
                false,
            )
        },
    )
    .expect("duplicate");

    assert_eq!(failed.records[0].outcome_status, failed_status());
    assert_eq!(mixed.records[0].outcome_status, blocked_status());
    assert_eq!(mixed.records[1].outcome_status, repair_status());
    assert_eq!(duplicate.records[0].outcome_status, duplicate_status());
}

#[test]
fn forge_network_execution_outcomes_block_raw_payloads_and_provider_writes() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

    let set = persist_forge_network_execution_outcomes(
        &state,
        input(
            request_receipt_set(vec![request_receipt("blocked", ready())]),
            stopped(),
            true,
        ),
    )
    .expect("blocked");
    let record = &set.records[0];

    assert_eq!(
        record.persistence_status,
        ForgeNetworkExecutionOutcomePersistenceStatus::Blocked
    );
    assert!(record
        .persistence_blockers
        .contains(&ForgeNetworkExecutionOutcomePersistenceBlocker::RawResponseBodyPresent));
    assert!(record
        .persistence_blockers
        .contains(&ForgeNetworkExecutionOutcomePersistenceBlocker::CredentialMaterialPresent));
    assert!(record
        .persistence_blockers
        .contains(&ForgeNetworkExecutionOutcomePersistenceBlocker::ProviderNetworkCallRequested));
    assert!(!record.provider_network_call_performed);
}

#[test]
fn forge_network_execution_outcome_diagnostics_and_control_summarize_records() {
    let diagnostics = forge_network_execution_outcome_diagnostics_from_persisted_records(vec![
        persisted("stopped", stopped()),
        persisted("failed", failed_status()),
        persisted("blocked", blocked_status()),
        persisted("repair", repair_status()),
        persisted("duplicate", duplicate_status()),
    ]);
    let dto = forge_network_execution_outcome_control_dto_from_diagnostics(diagnostics.clone());
    let json = serde_json::to_string(&dto).expect("serialize dto");

    assert_eq!(diagnostics.outcome_count, 5);
    assert_eq!(diagnostics.stopped_recorded_count, 1);
    assert_eq!(diagnostics.failed_count, 1);
    assert_eq!(diagnostics.blocked_count, 1);
    assert_eq!(diagnostics.repair_required_count, 1);
    assert_eq!(diagnostics.duplicate_noop_count, 1);
    assert_eq!(dto.outcome_count, 5);
    assert!(!dto.provider_network_call_performed);
    assert!(!dto.raw_provider_payload_retained);
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
    assert!(!json.contains("response_body"));
}

#[test]
fn forge_network_execution_outcomes_derive_status_from_request_receipt_status() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let mut record = request_receipt("repair", ready());
    record.status = ForgeNetworkExecutionRequestReceiptStatus::RepairRequired;

    let set = persist_forge_network_execution_outcomes(
        &state,
        input(request_receipt_set(vec![record]), stopped(), false),
    )
    .expect("persist");

    assert_eq!(set.records[0].outcome_status, repair_status());
}
