use super::*;
use crate::codex_supervision::{
    CodexAppServerObservationKind, CodexRuntimeObservationEventIdentityStatus,
};
use crate::ServerStateService;
use nucleus_local_store::SqliteBackend;

#[test]
fn observation_ingestion_cursor_persists_accepted_sequence_after_reopen() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));

    let cursor = apply_codex_runtime_observation_ingestion_cursor(
        &state,
        CodexRuntimeObservationIngestionCursorInput {
            identity: identity(1, "identity:1", "event:1"),
        },
    )
    .expect("apply cursor");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records =
        read_codex_runtime_observation_ingestion_cursors(&reopened).expect("read cursors");

    assert_eq!(records, vec![cursor]);
    assert_eq!(records[0].last_accepted_sequence, Some(1));
    assert_eq!(
        records[0].status,
        CodexRuntimeObservationIngestionCursorStatus::Accepted
    );
    assert!(!records[0].provider_io_executed);
    assert!(!records[0].task_mutation_permitted);
}

#[test]
fn observation_ingestion_cursor_duplicate_is_deterministic_noop() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let first = identity(1, "identity:1", "event:1");
    apply_codex_runtime_observation_ingestion_cursor(
        &state,
        CodexRuntimeObservationIngestionCursorInput {
            identity: first.clone(),
        },
    )
    .expect("first");

    let duplicate = apply_codex_runtime_observation_ingestion_cursor(
        &state,
        CodexRuntimeObservationIngestionCursorInput { identity: first },
    )
    .expect("duplicate");

    assert_eq!(duplicate.last_accepted_sequence, Some(1));
    assert_eq!(
        duplicate.accepted_identity_ids,
        vec!["identity:1".to_owned()]
    );
    assert_eq!(
        duplicate.status,
        CodexRuntimeObservationIngestionCursorStatus::DuplicateNoop
    );
}

#[test]
fn observation_ingestion_cursor_gap_requires_repair_without_advancing() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    apply_codex_runtime_observation_ingestion_cursor(
        &state,
        CodexRuntimeObservationIngestionCursorInput {
            identity: identity(1, "identity:1", "event:1"),
        },
    )
    .expect("first");

    let gap = apply_codex_runtime_observation_ingestion_cursor(
        &state,
        CodexRuntimeObservationIngestionCursorInput {
            identity: identity(3, "identity:3", "event:3"),
        },
    )
    .expect("gap");

    assert_eq!(gap.last_accepted_sequence, Some(1));
    assert_eq!(
        gap.status,
        CodexRuntimeObservationIngestionCursorStatus::GapRepairRequired
    );
    assert!(gap.repair_required);
    assert!(gap.repair_hint.unwrap().contains("expected 2"));
}

#[test]
fn observation_ingestion_cursor_blocks_identity_without_provider_io() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut blocked = identity(1, "identity:blocked", "event:blocked");
    blocked.status = CodexRuntimeObservationEventIdentityStatus::Blocked;

    let cursor = apply_codex_runtime_observation_ingestion_cursor(
        &state,
        CodexRuntimeObservationIngestionCursorInput { identity: blocked },
    )
    .expect("blocked");

    assert_eq!(
        cursor.status,
        CodexRuntimeObservationIngestionCursorStatus::IdentityBlocked
    );
    assert!(cursor.repair_required);
    assert!(!cursor.provider_io_executed);
    assert!(!cursor.task_mutation_permitted);
}

fn identity(
    sequence: u64,
    identity_id: &str,
    event_id: &str,
) -> CodexRuntimeObservationEventIdentityRecord {
    CodexRuntimeObservationEventIdentityRecord {
        identity_id: identity_id.to_owned(),
        event_id: event_id.to_owned(),
        command_id: "command:1".to_owned(),
        stream_ref: "stream:runtime-session:codex:1".to_owned(),
        target_ref: "provider-session-binding:1".to_owned(),
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: "runtime-session:codex:1".to_owned(),
        binding_id: "provider-session-binding:1".to_owned(),
        frame_source_id: format!("frame:{sequence}"),
        decode_outcome_id: format!("decode:{sequence}"),
        method: Some("turn/completed".to_owned()),
        sequence,
        observation_kind: CodexAppServerObservationKind::CanonicalRuntimeEvent,
        status: CodexRuntimeObservationEventIdentityStatus::Accepted,
        blockers: Vec::new(),
        confidence: "provider_session_binding".to_owned(),
        repair_state: "healthy".to_owned(),
        unsupported_observation_visible: false,
        replay_safe: true,
        raw_provider_material_retained: false,
        provider_io_executed: false,
        task_mutation_permitted: false,
    }
}
