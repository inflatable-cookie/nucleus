use super::super::stdio_frame_ingestion_persistence::CodexAppServerStdioFrameIngestionPersistenceRecord;
use super::super::stdio_frames::CodexAppServerStdioDecodeStatus;

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
