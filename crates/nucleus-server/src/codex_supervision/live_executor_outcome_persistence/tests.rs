use nucleus_engine::{EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptStatus};
use nucleus_local_store::SqliteBackend;
use nucleus_orchestration::{decode_orchestration_event_store_record, OrchestrationEventKind};

use super::*;
use crate::codex_supervision::{
    codex_live_executor_outcome_record, CodexAppServerLiveExecutorCleanupStatus,
    CodexAppServerLiveExecutorMethod, CodexAppServerLiveExecutorOutcomeInput,
    CodexAppServerLiveExecutorOutcomeStatus,
};
use crate::runtime_receipt_state::read_runtime_receipts;

fn completed_outcome() -> crate::CodexAppServerLiveExecutorOutcomeRecord {
    codex_live_executor_outcome_record(CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: "codex:local-default".to_owned(),
        write_attempt_id: "provider-transport-write:codex-live-smoke".to_owned(),
        receipt_refs: vec!["receipt:codex-live-smoke:transport".to_owned()],
        thread_id: Some("thread:codex-smoke".to_owned()),
        turn_id: Some("turn:codex-smoke".to_owned()),
        final_turn_status: Some("completed".to_owned()),
        status: CodexAppServerLiveExecutorOutcomeStatus::Completed,
        method_sequence: vec![
            CodexAppServerLiveExecutorMethod::Initialize,
            CodexAppServerLiveExecutorMethod::InitializedNotification,
            CodexAppServerLiveExecutorMethod::ThreadStart,
            CodexAppServerLiveExecutorMethod::TurnStart,
            CodexAppServerLiveExecutorMethod::TurnCompleted,
            CodexAppServerLiveExecutorMethod::Cleanup,
        ],
        notification_count: 1,
        server_request_count: 0,
        cleanup_status: CodexAppServerLiveExecutorCleanupStatus::Completed,
        evidence_refs: vec!["evidence:codex-live-smoke".to_owned()],
        provider_write_executed: true,
    })
}

#[test]
fn live_executor_outcome_survives_reopen_with_receipt_and_event() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = crate::ServerStateService::new(SqliteBackend::new(db.clone()));
    let outcome = completed_outcome();

    let persisted = persist_codex_live_executor_outcome(
        &state,
        CodexAppServerLiveExecutorOutcomePersistenceInput {
            outcome: outcome.clone(),
        },
    )
    .expect("persist outcome");

    let reopened = crate::ServerStateService::new(SqliteBackend::new(db));
    let outcomes = read_codex_live_executor_outcome_records(&reopened).expect("read outcomes");
    let receipts = read_runtime_receipts(&reopened).expect("read receipts");
    let events = reopened.event_journal().list().expect("read event records");
    let event = decode_orchestration_event_store_record(&events[0].payload.bytes).expect("event");

    assert_eq!(outcomes, vec![outcome]);
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].receipt_id, persisted.receipt_id);
    assert_eq!(
        receipts[0].family,
        EngineRuntimeReceiptEffectFamily::HarnessProvider
    );
    assert_eq!(receipts[0].status, EngineRuntimeReceiptStatus::Completed);
    assert_eq!(events.len(), 1);
    assert_eq!(persisted.event_id, Some(event.event_id.clone()));
    assert_eq!(
        event.kind,
        OrchestrationEventKind::RuntimeObservationAccepted
    );
    assert!(persisted.provider_write_executed);
    assert!(!persisted.raw_payload_persisted);
    assert!(!persisted.raw_stream_persisted);
    assert!(!persisted.task_mutation_permitted);
}

#[test]
fn duplicate_write_attempt_id_is_rejected_deterministically() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state =
        crate::ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let outcome = completed_outcome();

    persist_codex_live_executor_outcome(
        &state,
        CodexAppServerLiveExecutorOutcomePersistenceInput {
            outcome: outcome.clone(),
        },
    )
    .expect("first persist");
    let duplicate = persist_codex_live_executor_outcome(
        &state,
        CodexAppServerLiveExecutorOutcomePersistenceInput { outcome },
    );

    assert!(duplicate.is_err());
    assert_eq!(
        read_codex_live_executor_outcome_records(&state)
            .expect("read outcomes")
            .len(),
        1
    );
    assert_eq!(
        read_runtime_receipts(&state).expect("read receipts").len(),
        1
    );
}

#[test]
fn blocked_outcome_persists_receipt_without_observation_event() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state =
        crate::ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let outcome = codex_live_executor_outcome_record(CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: "codex:local-default".to_owned(),
        write_attempt_id: "provider-transport-write:codex-blocked".to_owned(),
        receipt_refs: vec!["receipt:codex-live-smoke:blocked".to_owned()],
        thread_id: None,
        turn_id: None,
        final_turn_status: None,
        status: CodexAppServerLiveExecutorOutcomeStatus::Blocked(
            "operator confirmation missing".to_owned(),
        ),
        method_sequence: vec![CodexAppServerLiveExecutorMethod::Initialize],
        notification_count: 0,
        server_request_count: 0,
        cleanup_status: CodexAppServerLiveExecutorCleanupStatus::NotRequired,
        evidence_refs: vec!["evidence:operator-policy".to_owned()],
        provider_write_executed: false,
    });

    let persisted = persist_codex_live_executor_outcome(
        &state,
        CodexAppServerLiveExecutorOutcomePersistenceInput { outcome },
    )
    .expect("persist blocked");
    let receipts = read_runtime_receipts(&state).expect("read receipts");

    assert_eq!(persisted.event_id, None);
    assert_eq!(receipts[0].status, EngineRuntimeReceiptStatus::Blocked);
    assert!(state.event_journal().list().expect("events").is_empty());
}

#[test]
fn persistence_rejects_raw_material_authority_flags() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state =
        crate::ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut outcome = completed_outcome();
    outcome.raw_payload_retained = true;
    outcome.raw_stream_retained = true;
    outcome.task_mutation_permitted = true;

    let result = persist_codex_live_executor_outcome(
        &state,
        CodexAppServerLiveExecutorOutcomePersistenceInput { outcome },
    );

    assert!(result.is_err());
    assert!(read_codex_live_executor_outcome_records(&state)
        .expect("read outcomes")
        .is_empty());
    assert!(read_runtime_receipts(&state)
        .expect("read receipts")
        .is_empty());
}

#[test]
fn persisted_payload_excludes_raw_provider_material_terms() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state =
        crate::ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));

    persist_codex_live_executor_outcome(
        &state,
        CodexAppServerLiveExecutorOutcomePersistenceInput {
            outcome: completed_outcome(),
        },
    )
    .expect("persist outcome");

    let mut payloads = Vec::new();
    payloads.extend(
        state
            .artifact_metadata()
            .list()
            .expect("metadata")
            .into_iter()
            .map(|record| record.payload.bytes),
    );
    payloads.extend(
        state
            .runtime_effects()
            .list()
            .expect("receipts")
            .into_iter()
            .map(|record| record.payload.bytes),
    );
    payloads.extend(
        state
            .event_journal()
            .list()
            .expect("events")
            .into_iter()
            .map(|record| record.payload.bytes),
    );

    for payload in payloads {
        let json = String::from_utf8(payload).expect("json");
        for forbidden in [
            "raw_prompt",
            "raw_response",
            "raw_frame",
            "stdout",
            "stderr",
            "stream_delta",
            "credential",
            "secret",
        ] {
            assert!(
                !json.contains(forbidden),
                "persisted payload leaked {forbidden}"
            );
        }
    }
}
