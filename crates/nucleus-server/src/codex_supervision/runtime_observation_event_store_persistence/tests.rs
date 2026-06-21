use super::*;
use crate::codex_supervision::CodexRuntimeObservationIngestionCursorStatus;
use crate::ServerStateService;
use nucleus_local_store::SqliteBackend;
use nucleus_orchestration::{decode_orchestration_event_store_record, OrchestrationEventKind};

#[test]
fn runtime_observation_event_store_persists_accepted_observation() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));

    let record = persist_codex_runtime_observation_event_store(
        &state,
        CodexRuntimeObservationEventStorePersistenceInput {
            identity: identity("identity:1", "event:1"),
            cursor: cursor(CodexRuntimeObservationIngestionCursorStatus::Accepted),
        },
    )
    .expect("persist event");
    let events = state.event_journal().list().expect("events");

    assert_eq!(
        record.status,
        CodexRuntimeObservationEventStorePersistenceStatus::Persisted
    );
    assert_eq!(events.len(), 1);
    let event = decode_orchestration_event_store_record(&events[0].payload.bytes).expect("event");
    assert_eq!(
        event.kind,
        OrchestrationEventKind::RuntimeObservationAccepted
    );
    assert_eq!(event.event_id.0, "event:1");
    assert!(!record.replay_runs_provider_work);
    assert!(!record.provider_io_executed);
    assert!(!record.task_mutation_permitted);
}

#[test]
fn runtime_observation_event_store_duplicate_is_noop() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let identity = identity("identity:1", "event:1");
    let cursor = cursor(CodexRuntimeObservationIngestionCursorStatus::Accepted);
    persist_codex_runtime_observation_event_store(
        &state,
        CodexRuntimeObservationEventStorePersistenceInput {
            identity: identity.clone(),
            cursor: cursor.clone(),
        },
    )
    .expect("first");

    let duplicate = persist_codex_runtime_observation_event_store(
        &state,
        CodexRuntimeObservationEventStorePersistenceInput { identity, cursor },
    )
    .expect("duplicate");

    assert_eq!(
        duplicate.status,
        CodexRuntimeObservationEventStorePersistenceStatus::DuplicateNoop
    );
    assert_eq!(state.event_journal().list().expect("events").len(), 1);
}

#[test]
fn runtime_observation_event_store_records_repair_evidence_for_rejected_observation() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));

    let record = persist_codex_runtime_observation_event_store(
        &state,
        CodexRuntimeObservationEventStorePersistenceInput {
            identity: identity("identity:gap", "event:gap"),
            cursor: cursor(CodexRuntimeObservationIngestionCursorStatus::GapRepairRequired),
        },
    )
    .expect("repair evidence");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records = read_codex_runtime_observation_event_store_records(&reopened)
        .expect("read persisted records");

    assert_eq!(records, vec![record.clone()]);
    assert_eq!(
        record.status,
        CodexRuntimeObservationEventStorePersistenceStatus::RepairEvidenceOnly
    );
    assert!(record.event_store_record.is_none());
    assert!(state.event_journal().list().expect("events").is_empty());
}

#[test]
fn runtime_observation_event_store_blocks_raw_provider_authority() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut identity = identity("identity:raw", "event:raw");
    identity.raw_provider_material_retained = true;

    let record = persist_codex_runtime_observation_event_store(
        &state,
        CodexRuntimeObservationEventStorePersistenceInput {
            identity,
            cursor: cursor(CodexRuntimeObservationIngestionCursorStatus::Accepted),
        },
    )
    .expect("blocked record");

    assert_eq!(
        record.status,
        CodexRuntimeObservationEventStorePersistenceStatus::Blocked
    );
    assert!(record.event_store_record.is_none());
    assert!(!record.replay_runs_provider_work);
    assert!(!record.provider_io_executed);
    assert!(!record.task_mutation_permitted);
}

fn identity(
    identity_id: &str,
    event_id: &str,
) -> super::super::runtime_observation_event_identity::CodexRuntimeObservationEventIdentityRecord {
    super::super::runtime_observation_event_identity::CodexRuntimeObservationEventIdentityRecord {
        identity_id: identity_id.to_owned(),
        event_id: event_id.to_owned(),
        command_id: "command:runtime:1".to_owned(),
        stream_ref: "stream:runtime-session:codex:1".to_owned(),
        target_ref: "provider-session-binding:1".to_owned(),
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: "runtime-session:codex:1".to_owned(),
        binding_id: "provider-session-binding:1".to_owned(),
        frame_source_id: "frame:1".to_owned(),
        decode_outcome_id: "decode:1".to_owned(),
        method: Some("turn/completed".to_owned()),
        sequence: 1,
        observation_kind: super::super::CodexAppServerObservationKind::CanonicalRuntimeEvent,
        status: super::super::runtime_observation_event_identity::CodexRuntimeObservationEventIdentityStatus::Accepted,
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

fn cursor(
    status: CodexRuntimeObservationIngestionCursorStatus,
) -> super::super::runtime_observation_ingestion_cursor::CodexRuntimeObservationIngestionCursorRecord
{
    super::super::runtime_observation_ingestion_cursor::CodexRuntimeObservationIngestionCursorRecord {
        cursor_id: "cursor:1".to_owned(),
        stream_ref: "stream:runtime-session:codex:1".to_owned(),
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: "runtime-session:codex:1".to_owned(),
        last_accepted_sequence: Some(1),
        accepted_identity_ids: vec!["identity:1".to_owned()],
        accepted_event_ids: vec!["event:1".to_owned()],
        status,
        repair_required: false,
        repair_hint: Some("repair".to_owned()),
        evidence_refs: vec!["evidence:cursor".to_owned()],
        provider_io_executed: false,
        task_mutation_permitted: false,
    }
}
