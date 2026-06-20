//! Codex stdio frame ingestion persistence.
//!
//! This module persists sanitized stdio frame source and decode evidence. It
//! does not retain raw stdio bytes, replay provider writes, parse live streams,
//! or mutate task state.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_engine::EngineRuntimeReceiptRecordId;
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use nucleus_orchestration::{
    encode_orchestration_event_store_record, EventStreamRef, OrchestrationCommandId,
    OrchestrationEventId, OrchestrationEventRecord, OrchestrationEventStoreRecord,
};
use serde::{Deserialize, Serialize};

use crate::runtime_receipt_state::write_runtime_receipt;
use crate::state::ServerStateService;

use super::stdio_frames::{
    CodexAppServerStdioDecodeStatus, CodexAppServerStdioFrameDirection,
    CodexAppServerStdioFrameSourceRecord,
};
use super::transport_receipts::codex_receipt_from_stdio_frame;

const INGESTION_RECORD_PREFIX: &str = "codex-stdio-frame-ingestion:";

/// Input for persisting one Codex stdio frame ingestion record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerStdioFrameIngestionPersistenceInput {
    pub frame: CodexAppServerStdioFrameSourceRecord,
}

/// Durable sanitized evidence for one Codex stdio frame ingestion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerStdioFrameIngestionPersistenceRecord {
    pub ingestion_id: String,
    pub frame_source_id: String,
    pub runtime_instance_id: String,
    pub session_refs: Vec<String>,
    pub sequence: u64,
    pub direction: CodexAppServerStdioFrameDirection,
    pub decode_status: CodexAppServerStdioDecodeStatus,
    pub decode_receipt_ref: String,
    pub frame_size_bytes: Option<u64>,
    pub payload_line_count: Option<u32>,
    pub receipt_id: EngineRuntimeReceiptRecordId,
    pub observation_event_id: Option<OrchestrationEventId>,
    pub evidence_refs: Vec<String>,
    pub raw_stream_retained: bool,
    pub raw_payload_retained: bool,
    pub task_mutation_permitted: bool,
}

/// Persist sanitized frame source, decode receipt, and optional observation event.
pub fn persist_codex_stdio_frame_ingestion<B>(
    state: &ServerStateService<B>,
    input: CodexAppServerStdioFrameIngestionPersistenceInput,
) -> LocalStoreResult<CodexAppServerStdioFrameIngestionPersistenceRecord>
where
    B: LocalStoreBackend,
{
    let receipt = codex_receipt_from_stdio_frame(&input.frame);
    let event = observation_event_from_frame(&input.frame);
    let record = persistence_record_from_parts(&input.frame, &receipt.receipt_id, &event);

    write_frame_ingestion_metadata(state, &record)?;
    write_runtime_receipt(
        state,
        &receipt,
        RevisionId(format!("rev:{}", receipt.receipt_id.0)),
        RevisionExpectation::MustNotExist,
    )?;

    if let Some(event) = &event {
        write_frame_ingestion_event(state, event)?;
    }

    Ok(record)
}

/// Read persisted Codex stdio frame ingestion records from server state.
pub fn read_codex_stdio_frame_ingestion_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<CodexAppServerStdioFrameIngestionPersistenceRecord>>
where
    B: LocalStoreBackend,
{
    state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(INGESTION_RECORD_PREFIX))
        .map(|record| decode_frame_ingestion_record(&record.payload.bytes))
        .collect()
}

fn persistence_record_from_parts(
    frame: &CodexAppServerStdioFrameSourceRecord,
    receipt_id: &EngineRuntimeReceiptRecordId,
    event: &Option<OrchestrationEventStoreRecord>,
) -> CodexAppServerStdioFrameIngestionPersistenceRecord {
    CodexAppServerStdioFrameIngestionPersistenceRecord {
        ingestion_id: ingestion_id(frame),
        frame_source_id: frame.frame_source_id.0.clone(),
        runtime_instance_id: frame.runtime_instance_id.clone(),
        session_refs: vec![frame.runtime_instance_id.clone()],
        sequence: frame.sequence,
        direction: frame.direction.clone(),
        decode_status: frame.decode_status.clone(),
        decode_receipt_ref: receipt_id.0.clone(),
        frame_size_bytes: None,
        payload_line_count: None,
        receipt_id: receipt_id.clone(),
        observation_event_id: event.as_ref().map(|event| event.event_id.clone()),
        evidence_refs: vec![frame.evidence_ref.clone()],
        raw_stream_retained: false,
        raw_payload_retained: false,
        task_mutation_permitted: false,
    }
}

fn write_frame_ingestion_metadata<B>(
    state: &ServerStateService<B>,
    record: &CodexAppServerStdioFrameIngestionPersistenceRecord,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    let payload = encode_frame_ingestion_record(record)?;

    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.ingestion_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.ingestion_id)),
            payload: json_payload(payload),
        },
        RevisionExpectation::MustNotExist,
    )
}

fn write_frame_ingestion_event<B>(
    state: &ServerStateService<B>,
    event: &OrchestrationEventStoreRecord,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    let payload = encode_orchestration_event_store_record(event).map_err(|error| {
        LocalStoreError::InvalidRecord {
            reason: error.to_string(),
        }
    })?;

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

fn observation_event_from_frame(
    frame: &CodexAppServerStdioFrameSourceRecord,
) -> Option<OrchestrationEventStoreRecord> {
    let method = match &frame.decode_status {
        CodexAppServerStdioDecodeStatus::Decoded { method } => method,
        CodexAppServerStdioDecodeStatus::Malformed { .. }
        | CodexAppServerStdioDecodeStatus::Unsupported { .. }
        | CodexAppServerStdioDecodeStatus::RecoveryRequired { .. } => return None,
    };

    let payload = OrchestrationEventRecord::runtime_observation_accepted(
        OrchestrationEventId(format!(
            "event:codex-stdio-frame-ingestion:{}",
            frame.frame_source_id.0
        )),
        OrchestrationCommandId(format!(
            "command:codex-stdio-frame-ingestion:{}",
            frame.runtime_instance_id
        )),
        Some(format!("{}:{}", frame.runtime_instance_id, method)),
    );

    Some(OrchestrationEventStoreRecord::from_event(
        EventStreamRef(format!(
            "stream:codex-stdio-frame-ingestion:{}",
            frame.runtime_instance_id
        )),
        payload,
    ))
}

fn encode_frame_ingestion_record(
    record: &CodexAppServerStdioFrameIngestionPersistenceRecord,
) -> LocalStoreResult<Vec<u8>> {
    serde_json::to_vec(&FrameIngestionRecordDto::from_record(record)).map_err(|error| {
        LocalStoreError::InvalidRecord {
            reason: error.to_string(),
        }
    })
}

fn decode_frame_ingestion_record(
    bytes: &[u8],
) -> LocalStoreResult<CodexAppServerStdioFrameIngestionPersistenceRecord> {
    let dto: FrameIngestionRecordDto =
        serde_json::from_slice(bytes).map_err(|error| LocalStoreError::InvalidRecord {
            reason: error.to_string(),
        })?;
    dto.into_record()
}

fn ingestion_id(frame: &CodexAppServerStdioFrameSourceRecord) -> String {
    format!("{}{}", INGESTION_RECORD_PREFIX, frame.frame_source_id.0)
}

fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct FrameIngestionRecordDto {
    ingestion_id: String,
    frame_source_id: String,
    runtime_instance_id: String,
    session_refs: Vec<String>,
    sequence: u64,
    direction: String,
    decode_status: FrameDecodeStatusDto,
    decode_receipt_ref: String,
    frame_size_bytes: Option<u64>,
    payload_line_count: Option<u32>,
    receipt_id: String,
    observation_event_id: Option<String>,
    evidence_refs: Vec<String>,
    raw_stream_retained: bool,
    raw_payload_retained: bool,
    task_mutation_permitted: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum FrameDecodeStatusDto {
    Decoded {
        method: String,
    },
    Malformed {
        reason: String,
    },
    Unsupported {
        method: Option<String>,
        reason: String,
    },
    RecoveryRequired {
        reason: String,
    },
}

impl FrameIngestionRecordDto {
    fn from_record(record: &CodexAppServerStdioFrameIngestionPersistenceRecord) -> Self {
        Self {
            ingestion_id: record.ingestion_id.clone(),
            frame_source_id: record.frame_source_id.clone(),
            runtime_instance_id: record.runtime_instance_id.clone(),
            session_refs: record.session_refs.clone(),
            sequence: record.sequence,
            direction: direction_to_str(&record.direction).to_owned(),
            decode_status: FrameDecodeStatusDto::from_decode_status(&record.decode_status),
            decode_receipt_ref: record.decode_receipt_ref.clone(),
            frame_size_bytes: record.frame_size_bytes,
            payload_line_count: record.payload_line_count,
            receipt_id: record.receipt_id.0.clone(),
            observation_event_id: record
                .observation_event_id
                .as_ref()
                .map(|event_id| event_id.0.clone()),
            evidence_refs: record.evidence_refs.clone(),
            raw_stream_retained: record.raw_stream_retained,
            raw_payload_retained: record.raw_payload_retained,
            task_mutation_permitted: record.task_mutation_permitted,
        }
    }

    fn into_record(self) -> LocalStoreResult<CodexAppServerStdioFrameIngestionPersistenceRecord> {
        Ok(CodexAppServerStdioFrameIngestionPersistenceRecord {
            ingestion_id: self.ingestion_id,
            frame_source_id: self.frame_source_id,
            runtime_instance_id: self.runtime_instance_id,
            session_refs: self.session_refs,
            sequence: self.sequence,
            direction: direction_from_str(&self.direction)?,
            decode_status: self.decode_status.into_decode_status(),
            decode_receipt_ref: self.decode_receipt_ref,
            frame_size_bytes: self.frame_size_bytes,
            payload_line_count: self.payload_line_count,
            receipt_id: EngineRuntimeReceiptRecordId(self.receipt_id),
            observation_event_id: self.observation_event_id.map(OrchestrationEventId),
            evidence_refs: self.evidence_refs,
            raw_stream_retained: self.raw_stream_retained,
            raw_payload_retained: self.raw_payload_retained,
            task_mutation_permitted: self.task_mutation_permitted,
        })
    }
}

impl FrameDecodeStatusDto {
    fn from_decode_status(status: &CodexAppServerStdioDecodeStatus) -> Self {
        match status {
            CodexAppServerStdioDecodeStatus::Decoded { method } => Self::Decoded {
                method: method.clone(),
            },
            CodexAppServerStdioDecodeStatus::Malformed { reason } => Self::Malformed {
                reason: reason.clone(),
            },
            CodexAppServerStdioDecodeStatus::Unsupported { method, reason } => Self::Unsupported {
                method: method.clone(),
                reason: reason.clone(),
            },
            CodexAppServerStdioDecodeStatus::RecoveryRequired { reason } => {
                Self::RecoveryRequired {
                    reason: reason.clone(),
                }
            }
        }
    }

    fn into_decode_status(self) -> CodexAppServerStdioDecodeStatus {
        match self {
            Self::Decoded { method } => CodexAppServerStdioDecodeStatus::Decoded { method },
            Self::Malformed { reason } => CodexAppServerStdioDecodeStatus::Malformed { reason },
            Self::Unsupported { method, reason } => {
                CodexAppServerStdioDecodeStatus::Unsupported { method, reason }
            }
            Self::RecoveryRequired { reason } => {
                CodexAppServerStdioDecodeStatus::RecoveryRequired { reason }
            }
        }
    }
}

fn direction_to_str(direction: &CodexAppServerStdioFrameDirection) -> &'static str {
    match direction {
        CodexAppServerStdioFrameDirection::ProviderStdout => "provider_stdout",
        CodexAppServerStdioFrameDirection::ProviderStderr => "provider_stderr",
        CodexAppServerStdioFrameDirection::ClientStdin => "client_stdin",
    }
}

fn direction_from_str(value: &str) -> LocalStoreResult<CodexAppServerStdioFrameDirection> {
    match value {
        "provider_stdout" => Ok(CodexAppServerStdioFrameDirection::ProviderStdout),
        "provider_stderr" => Ok(CodexAppServerStdioFrameDirection::ProviderStderr),
        "client_stdin" => Ok(CodexAppServerStdioFrameDirection::ClientStdin),
        other => Err(LocalStoreError::InvalidRecord {
            reason: format!("unknown stdio frame direction: {other}"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        codex_stdio_frame_source_record, CodexAppServerRuntimeInstanceRecord,
    };
    use crate::runtime_receipt_state::read_runtime_receipts;
    use nucleus_engine::EngineRuntimeReceiptStatus;
    use nucleus_local_store::SqliteBackend;
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
        let restored =
            read_codex_stdio_frame_ingestion_records(&reopened).expect("read frame records");

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
        let event =
            decode_orchestration_event_store_record(&events[0].payload.bytes).expect("event");
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
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
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
        let restored =
            read_codex_stdio_frame_ingestion_records(&state).expect("read frame records");

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
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
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
}
