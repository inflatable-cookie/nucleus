use serde::{Deserialize, Serialize};

/// Client-safe diagnostics for Codex transport executor handoff state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CodexTransportExecutorDiagnosticsDto {
    pub sessions: Vec<CodexTransportSessionDiagnosticDto>,
    pub authorities: Vec<CodexTransportExecutorAuthorityDiagnosticDto>,
    pub envelopes: Vec<CodexTransportExecutorEnvelopeDiagnosticDto>,
    pub executions: Vec<CodexTransportExecutionDiagnosticDto>,
    pub frames: Vec<CodexStdioFrameIngestionDiagnosticDto>,
    pub decode_outcomes: Vec<CodexDecodeOutcomeDiagnosticDto>,
    pub transport_receipts: Vec<CodexTransportReceiptDiagnosticDto>,
    pub session_count: usize,
    pub frame_count: usize,
    pub decode_outcome_count: usize,
    pub receipt_count: usize,
    pub repair_required_count: usize,
    pub client_can_execute_provider_write: bool,
    pub client_can_answer_callbacks: bool,
    pub client_can_cancel_provider: bool,
    pub client_can_mutate_tasks: bool,
    pub provider_material_exposed: bool,
    pub raw_streams_exposed: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CodexTransportSessionDiagnosticDto {
    pub binding_id: String,
    pub provider_instance_id: String,
    pub provider_service_id: String,
    pub runtime_session_ref: String,
    pub provider_session_ref: Option<String>,
    pub provider_thread_ref: Option<String>,
    pub lifecycle_state: String,
    pub evidence_refs: Vec<String>,
    pub repair_state: String,
    pub repair_required: bool,
    pub provider_write_permitted: bool,
    pub raw_provider_material_retained: bool,
    pub task_mutation_permitted: bool,
    pub next_action: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CodexTransportExecutorAuthorityDiagnosticDto {
    pub authority_id: String,
    pub provider_instance_id: String,
    pub preflight_id: String,
    pub write_attempt_id: String,
    pub status: String,
    pub blockers: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub task_mutation_permitted: bool,
    pub next_action: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CodexTransportExecutorEnvelopeDiagnosticDto {
    pub envelope_id: String,
    pub request_id: String,
    pub send_command_id: String,
    pub write_attempt_id: String,
    pub status: String,
    pub blockers: Vec<String>,
    pub receipt_id: String,
    pub event_id: String,
    pub evidence_refs: Vec<String>,
    pub raw_payload_retained: bool,
    pub raw_stream_retained: bool,
    pub task_mutation_permitted: bool,
    pub next_action: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CodexTransportExecutionDiagnosticDto {
    pub execution_id: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub receipt_id: String,
    pub event_id: Option<String>,
    pub replay_policy: String,
    pub provider_write_executed: bool,
    pub raw_payload_persisted: bool,
    pub raw_stream_persisted: bool,
    pub task_mutation_permitted: bool,
    pub next_action: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CodexStdioFrameIngestionDiagnosticDto {
    pub ingestion_id: String,
    pub frame_source_id: String,
    pub runtime_instance_id: String,
    pub sequence: u64,
    pub decode_status: String,
    pub receipt_id: String,
    pub observation_event_id: Option<String>,
    pub evidence_refs: Vec<String>,
    pub raw_payload_retained: bool,
    pub raw_stream_retained: bool,
    pub task_mutation_permitted: bool,
    pub next_action: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CodexDecodeOutcomeDiagnosticDto {
    pub outcome_id: String,
    pub frame_source_id: String,
    pub runtime_instance_id: String,
    pub sequence: u64,
    pub decode_status: String,
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
    pub next_action: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CodexTransportReceiptDiagnosticDto {
    pub receipt_id: String,
    pub status: String,
    pub family: String,
    pub command_ref: Option<String>,
    pub effect_ref: Option<String>,
    pub evidence_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub summary: Option<String>,
    pub recovery_required: bool,
    pub provider_material_exposed: bool,
    pub client_can_replay_effect: bool,
    pub next_action: String,
}
