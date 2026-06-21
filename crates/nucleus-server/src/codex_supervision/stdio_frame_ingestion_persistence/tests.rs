use super::*;
use crate::codex_supervision::{
    codex_stdio_frame_source_record, CodexAppServerRuntimeInstanceRecord,
    CodexAppServerStdioDecodeStatus, CodexAppServerStdioFrameDirection,
    CodexAppServerStdioFrameSourceRecord,
};
use crate::runtime_receipt_state::read_runtime_receipts;
use crate::state::ServerStateService;
use nucleus_engine::EngineRuntimeReceiptStatus;
use nucleus_local_store::{LocalStoreError, SqliteBackend};
use nucleus_orchestration::{decode_orchestration_event_store_record, OrchestrationEventKind};

#[test]
fn stdio_frame_source_persistence_survives_restart_without_raw_streams() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));
    let frame = decoded_frame(12);

    let persisted = persist_codex_stdio_frame_ingestion(
        &state,
        CodexAppServerStdioFrameIngestionPersistenceInput { frame },
    )
    .expect("persist frame");
    let receipts = read_runtime_receipts(&state).expect("read receipts");
    let events = state.event_journal().list().expect("read events");

    drop(state);
    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let restored = read_codex_stdio_frame_ingestion_records(&reopened).expect("read frame records");

    assert_eq!(restored, vec![persisted.clone()]);
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].status, EngineRuntimeReceiptStatus::Accepted);
    assert_eq!(
        persisted.session_refs,
        vec![persisted.runtime_instance_id.clone()]
    );
    assert_eq!(persisted.decode_receipt_ref, persisted.receipt_id.0);
    assert_eq!(persisted.frame_size_bytes, None);
    assert_eq!(persisted.payload_line_count, None);
    assert_eq!(events.len(), 1);
    let event = decode_orchestration_event_store_record(&events[0].payload.bytes).expect("event");
    assert_eq!(
        event.kind,
        OrchestrationEventKind::RuntimeObservationAccepted
    );
    assert_eq!(persisted.observation_event_id, Some(event.event_id.clone()));
    assert!(!persisted.raw_stream_retained);
    assert!(!persisted.raw_payload_retained);
    assert!(!persisted.task_mutation_permitted);

    let stored_json = String::from_utf8(
        reopened.artifact_metadata().list().expect("metadata")[0]
            .payload
            .bytes
            .clone(),
    )
    .expect("json");
    for forbidden in [
        "raw_stdio_stream",
        "raw_provider_payload",
        "credential",
        "secret",
    ] {
        assert!(
            !stored_json.contains(forbidden),
            "frame evidence leaked {forbidden}"
        );
    }
}

#[test]
fn stdio_frame_source_persistence_rejects_duplicate_frame_source() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let frame = decoded_frame(13);

    persist_codex_stdio_frame_ingestion(
        &state,
        CodexAppServerStdioFrameIngestionPersistenceInput {
            frame: frame.clone(),
        },
    )
    .expect("first persist");
    let duplicate = persist_codex_stdio_frame_ingestion(
        &state,
        CodexAppServerStdioFrameIngestionPersistenceInput { frame },
    )
    .expect_err("duplicate rejected");
    let restored = read_codex_stdio_frame_ingestion_records(&state).expect("read frame records");

    assert!(matches!(
        duplicate,
        LocalStoreError::RevisionConflict(_) | LocalStoreError::DuplicateRecord { .. }
    ));
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].sequence, 13);
    assert!(!restored[0].task_mutation_permitted);
}

#[test]
fn stdio_frame_source_persistence_keeps_decode_receipt_without_observation_event() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let frame = codex_stdio_frame_source_record(
        &runtime(),
        CodexAppServerStdioFrameDirection::ProviderStdout,
        14,
        CodexAppServerStdioDecodeStatus::Unsupported {
            method: Some("experimental/event".to_owned()),
            reason: "unsupported method".to_owned(),
        },
    );

    let persisted = persist_codex_stdio_frame_ingestion(
        &state,
        CodexAppServerStdioFrameIngestionPersistenceInput { frame },
    )
    .expect("persist unsupported");
    let receipts = read_runtime_receipts(&state).expect("read receipts");
    let events = state.event_journal().list().expect("read events");

    assert_eq!(receipts[0].status, EngineRuntimeReceiptStatus::Blocked);
    assert!(events.is_empty());
    assert_eq!(persisted.observation_event_id, None);
    assert!(matches!(
        persisted.decode_status,
        CodexAppServerStdioDecodeStatus::Unsupported { .. }
    ));
    assert!(!persisted.raw_stream_retained);
    assert!(!persisted.task_mutation_permitted);
}

fn decoded_frame(sequence: u64) -> CodexAppServerStdioFrameSourceRecord {
    codex_stdio_frame_source_record(
        &runtime(),
        CodexAppServerStdioFrameDirection::ProviderStdout,
        sequence,
        CodexAppServerStdioDecodeStatus::Decoded {
            method: "turn/completed".to_owned(),
        },
    )
}

fn runtime() -> CodexAppServerRuntimeInstanceRecord {
    crate::codex_supervision::test_support::runtime()
}
