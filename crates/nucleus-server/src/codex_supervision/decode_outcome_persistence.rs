//! Codex stdio decode outcome persistence.
//!
//! This module stores summarized decode outcomes derived from sanitized frame
//! ingestion records. It does not store JSON-RPC payloads, read provider
//! streams, execute provider I/O, or mutate task state.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::state::ServerStateService;

use super::stdio_frame_ingestion_persistence::CodexAppServerStdioFrameIngestionPersistenceRecord;
use super::stdio_frames::CodexAppServerStdioDecodeStatus;

const DECODE_OUTCOME_PREFIX: &str = "codex-stdio-decode-outcome:";

/// Input for persisting one summarized Codex stdio decode outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerDecodeOutcomePersistenceInput {
    pub ingestion: CodexAppServerStdioFrameIngestionPersistenceRecord,
}

/// Durable summarized decode outcome for one observed Codex stdio frame.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerDecodeOutcomePersistenceRecord {
    pub outcome_id: String,
    pub frame_source_id: String,
    pub runtime_instance_id: String,
    pub sequence: u64,
    pub decode_status: CodexAppServerStdioDecodeStatus,
    pub decoded_method: Option<String>,
    pub supported: bool,
    pub parse_failure: Option<String>,
    pub unsupported_reason: Option<String>,
    pub observation_event_ref: Option<String>,
    pub evidence_refs: Vec<String>,
    pub shape_summary: String,
    pub raw_json_rpc_payload_retained: bool,
    pub raw_provider_payload_retained: bool,
    pub provider_io_executed: bool,
    pub task_mutation_permitted: bool,
}

/// Persist one summarized decode outcome derived from sanitized ingestion.
pub fn persist_codex_decode_outcome<B>(
    state: &ServerStateService<B>,
    input: CodexAppServerDecodeOutcomePersistenceInput,
) -> LocalStoreResult<CodexAppServerDecodeOutcomePersistenceRecord>
where
    B: LocalStoreBackend,
{
    validate_ingestion_for_decode_outcome(&input.ingestion)?;
    let record = decode_outcome_from_ingestion(&input.ingestion);

    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.outcome_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.outcome_id)),
            payload: json_payload(encode_decode_outcome_record(&record)?),
        },
        RevisionExpectation::MustNotExist,
    )?;

    Ok(record)
}

/// Read persisted summarized Codex stdio decode outcomes.
pub fn read_codex_decode_outcome_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<CodexAppServerDecodeOutcomePersistenceRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(DECODE_OUTCOME_PREFIX))
        .map(|record| decode_decode_outcome_record(&record.payload.bytes))
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.outcome_id.cmp(&right.outcome_id));
    Ok(records)
}

fn validate_ingestion_for_decode_outcome(
    ingestion: &CodexAppServerStdioFrameIngestionPersistenceRecord,
) -> LocalStoreResult<()> {
    if ingestion.frame_source_id.trim().is_empty()
        || ingestion.runtime_instance_id.trim().is_empty()
        || ingestion.evidence_refs.is_empty()
    {
        return invalid("decode outcome requires frame source, runtime, and evidence refs");
    }
    if ingestion.raw_stream_retained
        || ingestion.raw_payload_retained
        || ingestion.task_mutation_permitted
    {
        return invalid("decode outcome cannot derive from raw or task-mutating ingestion");
    }

    Ok(())
}

fn decode_outcome_from_ingestion(
    ingestion: &CodexAppServerStdioFrameIngestionPersistenceRecord,
) -> CodexAppServerDecodeOutcomePersistenceRecord {
    let (decoded_method, supported, parse_failure, unsupported_reason, shape_summary) =
        match &ingestion.decode_status {
            CodexAppServerStdioDecodeStatus::Decoded { method } => (
                Some(method.clone()),
                true,
                None,
                None,
                format!("decoded method: {method}"),
            ),
            CodexAppServerStdioDecodeStatus::Malformed { reason } => (
                None,
                false,
                Some(reason.clone()),
                None,
                "malformed frame".to_owned(),
            ),
            CodexAppServerStdioDecodeStatus::Unsupported { method, reason } => (
                method.clone(),
                false,
                None,
                Some(reason.clone()),
                match method {
                    Some(method) => format!("unsupported method: {method}"),
                    None => "unsupported frame".to_owned(),
                },
            ),
            CodexAppServerStdioDecodeStatus::RecoveryRequired { reason } => (
                None,
                false,
                None,
                Some(reason.clone()),
                "recovery required".to_owned(),
            ),
        };

    CodexAppServerDecodeOutcomePersistenceRecord {
        outcome_id: format!("{}{}", DECODE_OUTCOME_PREFIX, ingestion.frame_source_id),
        frame_source_id: ingestion.frame_source_id.clone(),
        runtime_instance_id: ingestion.runtime_instance_id.clone(),
        sequence: ingestion.sequence,
        decode_status: ingestion.decode_status.clone(),
        decoded_method,
        supported,
        parse_failure,
        unsupported_reason,
        observation_event_ref: ingestion
            .observation_event_id
            .as_ref()
            .map(|event_id| event_id.0.clone()),
        evidence_refs: ingestion.evidence_refs.clone(),
        shape_summary,
        raw_json_rpc_payload_retained: false,
        raw_provider_payload_retained: false,
        provider_io_executed: false,
        task_mutation_permitted: false,
    }
}

fn encode_decode_outcome_record(
    record: &CodexAppServerDecodeOutcomePersistenceRecord,
) -> LocalStoreResult<Vec<u8>> {
    serde_json::to_vec(&DecodeOutcomeRecordDto::from_record(record)).map_err(json_error)
}

fn decode_decode_outcome_record(
    bytes: &[u8],
) -> LocalStoreResult<CodexAppServerDecodeOutcomePersistenceRecord> {
    let dto: DecodeOutcomeRecordDto = serde_json::from_slice(bytes).map_err(json_error)?;
    Ok(dto.into_record())
}

fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
    }
}

fn invalid<T>(reason: impl Into<String>) -> LocalStoreResult<T> {
    Err(LocalStoreError::InvalidRecord {
        reason: reason.into(),
    })
}

fn json_error(error: impl ToString) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct DecodeOutcomeRecordDto {
    outcome_id: String,
    frame_source_id: String,
    runtime_instance_id: String,
    sequence: u64,
    decode_status: DecodeStatusDto,
    decoded_method: Option<String>,
    supported: bool,
    parse_failure: Option<String>,
    unsupported_reason: Option<String>,
    observation_event_ref: Option<String>,
    evidence_refs: Vec<String>,
    shape_summary: String,
    raw_json_rpc_payload_retained: bool,
    raw_provider_payload_retained: bool,
    provider_io_executed: bool,
    task_mutation_permitted: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum DecodeStatusDto {
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

impl DecodeOutcomeRecordDto {
    fn from_record(record: &CodexAppServerDecodeOutcomePersistenceRecord) -> Self {
        Self {
            outcome_id: record.outcome_id.clone(),
            frame_source_id: record.frame_source_id.clone(),
            runtime_instance_id: record.runtime_instance_id.clone(),
            sequence: record.sequence,
            decode_status: DecodeStatusDto::from_decode_status(&record.decode_status),
            decoded_method: record.decoded_method.clone(),
            supported: record.supported,
            parse_failure: record.parse_failure.clone(),
            unsupported_reason: record.unsupported_reason.clone(),
            observation_event_ref: record.observation_event_ref.clone(),
            evidence_refs: record.evidence_refs.clone(),
            shape_summary: record.shape_summary.clone(),
            raw_json_rpc_payload_retained: record.raw_json_rpc_payload_retained,
            raw_provider_payload_retained: record.raw_provider_payload_retained,
            provider_io_executed: record.provider_io_executed,
            task_mutation_permitted: record.task_mutation_permitted,
        }
    }

    fn into_record(self) -> CodexAppServerDecodeOutcomePersistenceRecord {
        CodexAppServerDecodeOutcomePersistenceRecord {
            outcome_id: self.outcome_id,
            frame_source_id: self.frame_source_id,
            runtime_instance_id: self.runtime_instance_id,
            sequence: self.sequence,
            decode_status: self.decode_status.into_decode_status(),
            decoded_method: self.decoded_method,
            supported: self.supported,
            parse_failure: self.parse_failure,
            unsupported_reason: self.unsupported_reason,
            observation_event_ref: self.observation_event_ref,
            evidence_refs: self.evidence_refs,
            shape_summary: self.shape_summary,
            raw_json_rpc_payload_retained: self.raw_json_rpc_payload_retained,
            raw_provider_payload_retained: self.raw_provider_payload_retained,
            provider_io_executed: self.provider_io_executed,
            task_mutation_permitted: self.task_mutation_permitted,
        }
    }
}

impl DecodeStatusDto {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        codex_stdio_frame_source_record, persist_codex_stdio_frame_ingestion,
        CodexAppServerStdioFrameDirection, CodexAppServerStdioFrameIngestionPersistenceInput,
    };
    use crate::ServerStateService;
    use nucleus_local_store::SqliteBackend;

    #[test]
    fn decode_outcome_persistence_stores_supported_and_unsupported_outcomes() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
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
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
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
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
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
}
