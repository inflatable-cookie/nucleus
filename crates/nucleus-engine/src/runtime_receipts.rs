//! Engine-owned runtime receipt records.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct EngineRuntimeReceiptRecordId(pub String);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineRuntimeReceiptEffectFamily {
    CommandExecution,
    HarnessProvider,
    ToolCall,
    ScmForge,
    CheckpointDiff,
    Research,
    Memory,
    Effigy,
    Steward,
    Custom(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineRuntimeReceiptStatus {
    Accepted,
    Queued,
    Started,
    InProgress,
    WaitingForApproval,
    WaitingForUserInput,
    Blocked,
    Completed,
    CompletedWithWarnings,
    Cancelled,
    Failed,
    TimedOut,
    RecoveryRequired,
    Recovered,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum EngineRuntimeReceiptRef {
    CommandId(String),
    CommandRequestId(String),
    CommandEvidenceId(String),
    Artifact(String),
    EventId(String),
    Custom(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EngineRuntimeReceiptRecord {
    pub receipt_id: EngineRuntimeReceiptRecordId,
    pub family: EngineRuntimeReceiptEffectFamily,
    pub status: EngineRuntimeReceiptStatus,
    pub command_ref: Option<EngineRuntimeReceiptRef>,
    pub effect_ref: Option<EngineRuntimeReceiptRef>,
    pub evidence_refs: Vec<EngineRuntimeReceiptRef>,
    pub artifact_refs: Vec<EngineRuntimeReceiptRef>,
    pub summary: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeReceiptRecordCodecError {
    pub reason: String,
}

pub fn encode_runtime_receipt_record(
    record: &EngineRuntimeReceiptRecord,
) -> Result<Vec<u8>, RuntimeReceiptRecordCodecError> {
    serde_json::to_vec(record).map_err(codec_error)
}

pub fn decode_runtime_receipt_record(
    bytes: &[u8],
) -> Result<EngineRuntimeReceiptRecord, RuntimeReceiptRecordCodecError> {
    serde_json::from_slice(bytes).map_err(codec_error)
}

fn codec_error(error: serde_json::Error) -> RuntimeReceiptRecordCodecError {
    RuntimeReceiptRecordCodecError {
        reason: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_receipt_round_trips_without_raw_output_fields() {
        let record = EngineRuntimeReceiptRecord {
            receipt_id: EngineRuntimeReceiptRecordId("receipt:1".to_owned()),
            family: EngineRuntimeReceiptEffectFamily::CommandExecution,
            status: EngineRuntimeReceiptStatus::Completed,
            command_ref: Some(EngineRuntimeReceiptRef::CommandId("command:1".to_owned())),
            effect_ref: Some(EngineRuntimeReceiptRef::CommandRequestId(
                "command:1:request".to_owned(),
            )),
            evidence_refs: vec![EngineRuntimeReceiptRef::CommandEvidenceId(
                "evidence:1".to_owned(),
            )],
            artifact_refs: Vec::new(),
            summary: Some("sanitized command summary".to_owned()),
        };

        let bytes = encode_runtime_receipt_record(&record).expect("encode receipt");
        let decoded = decode_runtime_receipt_record(&bytes).expect("decode receipt");
        let json = String::from_utf8(bytes).expect("json");

        assert_eq!(decoded, record);
        for forbidden in [
            "raw_stdout",
            "raw_stderr",
            "terminal_stream",
            "shell_trace",
            "environment",
            "credential",
        ] {
            assert!(!json.contains(forbidden), "receipt leaked {forbidden}");
        }
    }
}
