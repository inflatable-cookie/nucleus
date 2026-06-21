use nucleus_local_store::{LocalStoreRecordPayload, LocalStoreResult};
use serde::{Deserialize, Serialize};

use super::super::stdio_frames::CodexAppServerStdioDecodeStatus;
use super::types::CodexAppServerDecodeOutcomePersistenceRecord;
use super::validation::json_error;

pub(super) fn encode_decode_outcome_record(
    record: &CodexAppServerDecodeOutcomePersistenceRecord,
) -> LocalStoreResult<Vec<u8>> {
    serde_json::to_vec(&DecodeOutcomeRecordDto::from_record(record)).map_err(json_error)
}

pub(super) fn decode_decode_outcome_record(
    bytes: &[u8],
) -> LocalStoreResult<CodexAppServerDecodeOutcomePersistenceRecord> {
    let dto: DecodeOutcomeRecordDto = serde_json::from_slice(bytes).map_err(json_error)?;
    Ok(dto.into_record())
}

pub(super) fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
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
