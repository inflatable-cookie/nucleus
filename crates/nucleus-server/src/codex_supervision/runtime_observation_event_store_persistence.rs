//! Runtime observation event-store persistence.
//!
//! This module promotes accepted runtime observation identities into
//! orchestration event-store records. Rejected observations are persisted only
//! as sanitized repair evidence.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use nucleus_orchestration::{
    encode_orchestration_event_store_record, EventStreamRef, OrchestrationCommandId,
    OrchestrationEventId, OrchestrationEventRecord, OrchestrationEventStoreRecord,
};
use serde::{Deserialize, Serialize};

use crate::state::ServerStateService;

use super::runtime_observation_event_identity::{
    CodexRuntimeObservationEventIdentityRecord, CodexRuntimeObservationEventIdentityStatus,
};
use super::runtime_observation_ingestion_cursor::{
    CodexRuntimeObservationIngestionCursorRecord, CodexRuntimeObservationIngestionCursorStatus,
};

const EVENT_PERSISTENCE_PREFIX: &str = "codex-runtime-observation-event-persistence:";

/// Input for persisting one runtime observation event-store promotion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexRuntimeObservationEventStorePersistenceInput {
    pub identity: CodexRuntimeObservationEventIdentityRecord,
    pub cursor: CodexRuntimeObservationIngestionCursorRecord,
}

/// Durable sanitized outcome for one runtime observation event-store promotion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexRuntimeObservationEventStorePersistenceRecord {
    pub persistence_id: String,
    pub identity_id: String,
    pub event_id: Option<String>,
    pub command_id: String,
    pub stream_ref: String,
    pub target_ref: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub binding_id: String,
    pub frame_source_id: String,
    pub decode_outcome_id: String,
    pub method: Option<String>,
    pub observation_kind: String,
    pub status: CodexRuntimeObservationEventStorePersistenceStatus,
    pub repair_hint: Option<String>,
    pub evidence_refs: Vec<String>,
    pub event_store_record: Option<OrchestrationEventStoreRecord>,
    pub replay_runs_provider_work: bool,
    pub raw_provider_material_retained: bool,
    pub provider_io_executed: bool,
    pub task_mutation_permitted: bool,
}

/// Event-store persistence status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexRuntimeObservationEventStorePersistenceStatus {
    Persisted,
    DuplicateNoop,
    RepairEvidenceOnly,
    Blocked,
}

/// Persist one accepted runtime observation as an orchestration event.
pub fn persist_codex_runtime_observation_event_store<B>(
    state: &ServerStateService<B>,
    input: CodexRuntimeObservationEventStorePersistenceInput,
) -> LocalStoreResult<CodexRuntimeObservationEventStorePersistenceRecord>
where
    B: LocalStoreBackend,
{
    let mut record = persistence_record_from_input(&input);

    if record.status == CodexRuntimeObservationEventStorePersistenceStatus::Persisted {
        if state
            .event_journal()
            .get(&PersistenceRecordId(
                record
                    .event_id
                    .clone()
                    .expect("event id for persisted record"),
            ))?
            .is_some()
        {
            record.status = CodexRuntimeObservationEventStorePersistenceStatus::DuplicateNoop;
            record.event_store_record = None;
        } else if let Some(event_store_record) = &record.event_store_record {
            write_event_store_record(state, event_store_record)?;
        }
    }

    write_persistence_record(state, &record)?;
    Ok(record)
}

/// Read persisted runtime observation event-store promotion records.
pub fn read_codex_runtime_observation_event_store_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<CodexRuntimeObservationEventStorePersistenceRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(EVENT_PERSISTENCE_PREFIX))
        .map(|record| decode_persistence_record(&record.payload.bytes))
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.persistence_id.cmp(&right.persistence_id));
    Ok(records)
}

fn persistence_record_from_input(
    input: &CodexRuntimeObservationEventStorePersistenceInput,
) -> CodexRuntimeObservationEventStorePersistenceRecord {
    let status = persistence_status(input);
    let event_store_record =
        if status == CodexRuntimeObservationEventStorePersistenceStatus::Persisted {
            Some(event_store_record_from_identity(&input.identity))
        } else {
            None
        };
    let repair_hint = match status {
        CodexRuntimeObservationEventStorePersistenceStatus::Persisted
        | CodexRuntimeObservationEventStorePersistenceStatus::DuplicateNoop => None,
        CodexRuntimeObservationEventStorePersistenceStatus::RepairEvidenceOnly => input
            .cursor
            .repair_hint
            .clone()
            .or_else(|| Some("runtime observation not accepted by cursor".to_owned())),
        CodexRuntimeObservationEventStorePersistenceStatus::Blocked => {
            Some("runtime observation identity is blocked".to_owned())
        }
    };

    CodexRuntimeObservationEventStorePersistenceRecord {
        persistence_id: format!("{}{}", EVENT_PERSISTENCE_PREFIX, input.identity.identity_id),
        identity_id: input.identity.identity_id.clone(),
        event_id: event_store_record
            .as_ref()
            .map(|record| record.event_id.0.clone()),
        command_id: input.identity.command_id.clone(),
        stream_ref: input.identity.stream_ref.clone(),
        target_ref: input.identity.target_ref.clone(),
        provider_instance_id: input.identity.provider_instance_id.clone(),
        runtime_session_ref: input.identity.runtime_session_ref.clone(),
        binding_id: input.identity.binding_id.clone(),
        frame_source_id: input.identity.frame_source_id.clone(),
        decode_outcome_id: input.identity.decode_outcome_id.clone(),
        method: input.identity.method.clone(),
        observation_kind: format!("{:?}", input.identity.observation_kind),
        status,
        repair_hint,
        evidence_refs: input.cursor.evidence_refs.clone(),
        event_store_record,
        replay_runs_provider_work: false,
        raw_provider_material_retained: false,
        provider_io_executed: false,
        task_mutation_permitted: false,
    }
}

fn persistence_status(
    input: &CodexRuntimeObservationEventStorePersistenceInput,
) -> CodexRuntimeObservationEventStorePersistenceStatus {
    if input.identity.status == CodexRuntimeObservationEventIdentityStatus::Blocked
        || input.identity.raw_provider_material_retained
        || input.identity.provider_io_executed
        || input.identity.task_mutation_permitted
    {
        return CodexRuntimeObservationEventStorePersistenceStatus::Blocked;
    }
    if input.identity.status == CodexRuntimeObservationEventIdentityStatus::UnsupportedObservation {
        return CodexRuntimeObservationEventStorePersistenceStatus::RepairEvidenceOnly;
    }
    match input.cursor.status {
        CodexRuntimeObservationIngestionCursorStatus::Accepted => {
            CodexRuntimeObservationEventStorePersistenceStatus::Persisted
        }
        CodexRuntimeObservationIngestionCursorStatus::DuplicateNoop => {
            CodexRuntimeObservationEventStorePersistenceStatus::DuplicateNoop
        }
        CodexRuntimeObservationIngestionCursorStatus::StaleBlocked
        | CodexRuntimeObservationIngestionCursorStatus::GapRepairRequired => {
            CodexRuntimeObservationEventStorePersistenceStatus::RepairEvidenceOnly
        }
        CodexRuntimeObservationIngestionCursorStatus::IdentityBlocked => {
            CodexRuntimeObservationEventStorePersistenceStatus::Blocked
        }
    }
}

fn event_store_record_from_identity(
    identity: &CodexRuntimeObservationEventIdentityRecord,
) -> OrchestrationEventStoreRecord {
    let payload = OrchestrationEventRecord::runtime_observation_accepted(
        OrchestrationEventId(identity.event_id.clone()),
        OrchestrationCommandId(identity.command_id.clone()),
        Some(identity.target_ref.clone()),
    );
    OrchestrationEventStoreRecord::from_event(EventStreamRef(identity.stream_ref.clone()), payload)
}

fn write_event_store_record<B>(
    state: &ServerStateService<B>,
    event: &OrchestrationEventStoreRecord,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    let payload = encode_orchestration_event_store_record(event).map_err(json_error)?;

    state.event_journal().put(
        LocalStoreRecord {
            id: PersistenceRecordId(event.event_id.0.clone()),
            domain: PersistenceDomain::EventJournal,
            kind: PersistenceRecordKind::Event,
            revision_id: RevisionId(format!("rev:{}", event.event_id.0)),
            payload: json_payload(payload),
        },
        RevisionExpectation::MustNotExist,
    )
}

fn write_persistence_record<B>(
    state: &ServerStateService<B>,
    record: &CodexRuntimeObservationEventStorePersistenceRecord,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.persistence_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.persistence_id)),
            payload: json_payload(encode_persistence_record(record)?),
        },
        RevisionExpectation::Any,
    )
}

fn encode_persistence_record(
    record: &CodexRuntimeObservationEventStorePersistenceRecord,
) -> LocalStoreResult<Vec<u8>> {
    serde_json::to_vec(&PersistenceRecordDto::from_record(record)).map_err(json_error)
}

fn decode_persistence_record(
    bytes: &[u8],
) -> LocalStoreResult<CodexRuntimeObservationEventStorePersistenceRecord> {
    let dto: PersistenceRecordDto = serde_json::from_slice(bytes).map_err(json_error)?;
    dto.into_record()
}

fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
    }
}

fn json_error(error: impl ToString) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PersistenceRecordDto {
    persistence_id: String,
    identity_id: String,
    event_id: Option<String>,
    command_id: String,
    stream_ref: String,
    target_ref: String,
    provider_instance_id: String,
    runtime_session_ref: String,
    binding_id: String,
    frame_source_id: String,
    decode_outcome_id: String,
    method: Option<String>,
    observation_kind: String,
    status: String,
    repair_hint: Option<String>,
    evidence_refs: Vec<String>,
    replay_runs_provider_work: bool,
    raw_provider_material_retained: bool,
    provider_io_executed: bool,
    task_mutation_permitted: bool,
}

impl PersistenceRecordDto {
    fn from_record(record: &CodexRuntimeObservationEventStorePersistenceRecord) -> Self {
        Self {
            persistence_id: record.persistence_id.clone(),
            identity_id: record.identity_id.clone(),
            event_id: record.event_id.clone(),
            command_id: record.command_id.clone(),
            stream_ref: record.stream_ref.clone(),
            target_ref: record.target_ref.clone(),
            provider_instance_id: record.provider_instance_id.clone(),
            runtime_session_ref: record.runtime_session_ref.clone(),
            binding_id: record.binding_id.clone(),
            frame_source_id: record.frame_source_id.clone(),
            decode_outcome_id: record.decode_outcome_id.clone(),
            method: record.method.clone(),
            observation_kind: record.observation_kind.clone(),
            status: status_to_str(&record.status).to_owned(),
            repair_hint: record.repair_hint.clone(),
            evidence_refs: record.evidence_refs.clone(),
            replay_runs_provider_work: record.replay_runs_provider_work,
            raw_provider_material_retained: record.raw_provider_material_retained,
            provider_io_executed: record.provider_io_executed,
            task_mutation_permitted: record.task_mutation_permitted,
        }
    }

    fn into_record(self) -> LocalStoreResult<CodexRuntimeObservationEventStorePersistenceRecord> {
        let event_store_record = self.event_id.as_ref().map(|event_id| {
            let payload = OrchestrationEventRecord::runtime_observation_accepted(
                OrchestrationEventId(event_id.clone()),
                OrchestrationCommandId(self.command_id.clone()),
                Some(self.target_ref.clone()),
            );
            OrchestrationEventStoreRecord::from_event(
                EventStreamRef(self.stream_ref.clone()),
                payload,
            )
        });

        Ok(CodexRuntimeObservationEventStorePersistenceRecord {
            persistence_id: self.persistence_id,
            identity_id: self.identity_id,
            event_id: self.event_id,
            command_id: self.command_id,
            stream_ref: self.stream_ref,
            target_ref: self.target_ref,
            provider_instance_id: self.provider_instance_id,
            runtime_session_ref: self.runtime_session_ref,
            binding_id: self.binding_id,
            frame_source_id: self.frame_source_id,
            decode_outcome_id: self.decode_outcome_id,
            method: self.method,
            observation_kind: self.observation_kind,
            status: status_from_str(&self.status),
            repair_hint: self.repair_hint,
            evidence_refs: self.evidence_refs,
            event_store_record,
            replay_runs_provider_work: self.replay_runs_provider_work,
            raw_provider_material_retained: self.raw_provider_material_retained,
            provider_io_executed: self.provider_io_executed,
            task_mutation_permitted: self.task_mutation_permitted,
        })
    }
}

fn status_to_str(status: &CodexRuntimeObservationEventStorePersistenceStatus) -> &'static str {
    match status {
        CodexRuntimeObservationEventStorePersistenceStatus::Persisted => "persisted",
        CodexRuntimeObservationEventStorePersistenceStatus::DuplicateNoop => "duplicate_noop",
        CodexRuntimeObservationEventStorePersistenceStatus::RepairEvidenceOnly => {
            "repair_evidence_only"
        }
        CodexRuntimeObservationEventStorePersistenceStatus::Blocked => "blocked",
    }
}

fn status_from_str(value: &str) -> CodexRuntimeObservationEventStorePersistenceStatus {
    match value {
        "persisted" => CodexRuntimeObservationEventStorePersistenceStatus::Persisted,
        "duplicate_noop" => CodexRuntimeObservationEventStorePersistenceStatus::DuplicateNoop,
        "repair_evidence_only" => {
            CodexRuntimeObservationEventStorePersistenceStatus::RepairEvidenceOnly
        }
        _ => CodexRuntimeObservationEventStorePersistenceStatus::Blocked,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::CodexRuntimeObservationIngestionCursorStatus;
    use crate::ServerStateService;
    use nucleus_local_store::SqliteBackend;
    use nucleus_orchestration::{decode_orchestration_event_store_record, OrchestrationEventKind};

    #[test]
    fn runtime_observation_event_store_persists_accepted_observation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));

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
        let event =
            decode_orchestration_event_store_record(&events[0].payload.bytes).expect("event");
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
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
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
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
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

    fn identity(identity_id: &str, event_id: &str) -> CodexRuntimeObservationEventIdentityRecord {
        CodexRuntimeObservationEventIdentityRecord {
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

    fn cursor(
        status: CodexRuntimeObservationIngestionCursorStatus,
    ) -> CodexRuntimeObservationIngestionCursorRecord {
        CodexRuntimeObservationIngestionCursorRecord {
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
}
