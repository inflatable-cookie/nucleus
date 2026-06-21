use nucleus_engine::EngineRuntimeReceiptRecordId;
use nucleus_orchestration::OrchestrationEventId;

use super::super::stdio_frames::{
    CodexAppServerStdioDecodeStatus, CodexAppServerStdioFrameDirection,
    CodexAppServerStdioFrameSourceRecord,
};

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
