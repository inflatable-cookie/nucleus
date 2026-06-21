use super::*;
use crate::codex_supervision::{
    codex_stdio_frame_source_record, persist_codex_stdio_frame_ingestion,
    CodexAppServerStdioDecodeStatus, CodexAppServerStdioFrameDirection,
    CodexAppServerStdioFrameIngestionPersistenceInput,
    CodexAppServerStdioFrameIngestionPersistenceRecord,
};
use crate::ServerStateService;
use nucleus_local_store::{LocalStoreError, SqliteBackend};

#[test]
fn decode_outcome_persistence_stores_supported_and_unsupported_outcomes() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let decoded = persist_ingestion(
        &state,
        1,
        CodexAppServerStdioDecodeStatus::Decoded {
            method: "turn/completed".to_owned(),
        },
    );
    let unsupported = persist_ingestion(
        &state,
        2,
        CodexAppServerStdioDecodeStatus::Unsupported {
            method: Some("experimental/event".to_owned()),
            reason: "unsupported method".to_owned(),
        },
    );

    let decoded_outcome = persist_codex_decode_outcome(
        &state,
        CodexAppServerDecodeOutcomePersistenceInput { ingestion: decoded },
    )
    .expect("persist decoded outcome");
    let unsupported_outcome = persist_codex_decode_outcome(
        &state,
        CodexAppServerDecodeOutcomePersistenceInput {
            ingestion: unsupported,
        },
    )
    .expect("persist unsupported outcome");

    assert!(decoded_outcome.supported);
    assert_eq!(
        decoded_outcome.decoded_method,
        Some("turn/completed".to_owned())
    );
    assert!(!unsupported_outcome.supported);
    assert_eq!(
        unsupported_outcome.unsupported_reason,
        Some("unsupported method".to_owned())
    );
    assert_eq!(read_codex_decode_outcome_records(&state).unwrap().len(), 2);
}

#[test]
fn decode_outcome_persistence_keeps_parse_failures_inspectable_after_reopen() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));
    let malformed = persist_ingestion(
        &state,
        3,
        CodexAppServerStdioDecodeStatus::Malformed {
            reason: "invalid json".to_owned(),
        },
    );
    let persisted = persist_codex_decode_outcome(
        &state,
        CodexAppServerDecodeOutcomePersistenceInput {
            ingestion: malformed,
        },
    )
    .expect("persist malformed");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records = read_codex_decode_outcome_records(&reopened).expect("read outcomes");

    assert_eq!(records, vec![persisted]);
    assert_eq!(records[0].parse_failure, Some("invalid json".to_owned()));
    assert!(!records[0].raw_json_rpc_payload_retained);
    assert!(!records[0].raw_provider_payload_retained);
    assert!(!records[0].provider_io_executed);
    assert!(!records[0].task_mutation_permitted);
}

#[test]
fn decode_outcome_persistence_blocks_raw_payload_sources() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut ingestion = persist_ingestion(
        &state,
        4,
        CodexAppServerStdioDecodeStatus::Decoded {
            method: "turn/completed".to_owned(),
        },
    );
    ingestion.raw_payload_retained = true;

    let error = persist_codex_decode_outcome(
        &state,
        CodexAppServerDecodeOutcomePersistenceInput { ingestion },
    )
    .unwrap_err();

    assert!(matches!(error, LocalStoreError::InvalidRecord { .. }));
}

#[test]
fn decode_outcome_persistence_excludes_raw_json_rpc_material() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let ingestion = persist_ingestion(
        &state,
        5,
        CodexAppServerStdioDecodeStatus::Decoded {
            method: "turn/completed".to_owned(),
        },
    );
    let outcome = persist_codex_decode_outcome(
        &state,
        CodexAppServerDecodeOutcomePersistenceInput { ingestion },
    )
    .expect("persist outcome");
    let json = String::from_utf8(
        state.artifact_metadata().list().expect("metadata")[1]
            .payload
            .bytes
            .clone(),
    )
    .expect("json");

    for forbidden in ["jsonrpc\":\"2.0", "raw_provider_payload", "secret-value"] {
        assert!(
            !json.contains(forbidden),
            "decode outcome leaked {forbidden}"
        );
    }
    assert!(!outcome.provider_io_executed);
    assert!(!outcome.task_mutation_permitted);
}

fn persist_ingestion(
    state: &ServerStateService<SqliteBackend>,
    sequence: u64,
    decode_status: CodexAppServerStdioDecodeStatus,
) -> CodexAppServerStdioFrameIngestionPersistenceRecord {
    let frame = codex_stdio_frame_source_record(
        &crate::codex_supervision::test_support::runtime(),
        CodexAppServerStdioFrameDirection::ProviderStdout,
        sequence,
        decode_status,
    );
    persist_codex_stdio_frame_ingestion(
        state,
        CodexAppServerStdioFrameIngestionPersistenceInput { frame },
    )
    .expect("persist ingestion")
}
