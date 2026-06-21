use nucleus_engine::EngineRuntimeReceiptRecordId;
use nucleus_local_store::{LocalStoreError, LocalStoreRecordPayload, LocalStoreResult};
use nucleus_orchestration::OrchestrationEventId;
use serde::{Deserialize, Serialize};

use super::super::stdio_frames::{
    CodexAppServerStdioDecodeStatus, CodexAppServerStdioFrameDirection,
};
use super::types::CodexAppServerStdioFrameIngestionPersistenceRecord;

pub(super) fn encode_frame_ingestion_record(
    record: &CodexAppServerStdioFrameIngestionPersistenceRecord,
) -> LocalStoreResult<Vec<u8>> {
    serde_json::to_vec(&FrameIngestionRecordDto::from_record(record)).map_err(|error| {
        LocalStoreError::InvalidRecord {
            reason: error.to_string(),
        }
    })
}

pub(super) fn decode_frame_ingestion_record(
    bytes: &[u8],
) -> LocalStoreResult<CodexAppServerStdioFrameIngestionPersistenceRecord> {
    let dto: FrameIngestionRecordDto =
        serde_json::from_slice(bytes).map_err(|error| LocalStoreError::InvalidRecord {
            reason: error.to_string(),
        })?;
    dto.into_record()
}

pub(super) fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
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
