use nucleus_orchestration::OrchestrationEventId;

use super::super::live_send_preflight::CodexAppServerLiveSendPreflightRecord;
use super::super::transport_executor_authority::CodexAppServerTransportExecutorAuthorityRecord;
use super::super::turn_start_live_send_receipts::CodexAppServerTurnStartLiveSendReceiptLink;
use super::super::turn_start_send_command::CodexAppServerTurnStartSendCommandRecord;
use crate::provider_service_runtime::ProviderServiceId;
use crate::provider_transport_write::{
    ProviderTransportWriteAttemptRecord, ProviderTransportWriteTarget,
};

/// Stable id for one Codex `turn/start` stdio execution envelope.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerTurnStartStdioExecutionEnvelopeId(pub String);

/// Input for building a Codex `turn/start` stdio execution envelope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartStdioExecutionEnvelopeInput {
    pub send_command: CodexAppServerTurnStartSendCommandRecord,
    pub preflight: CodexAppServerLiveSendPreflightRecord,
    pub write_attempt: ProviderTransportWriteAttemptRecord,
    pub receipt_link: CodexAppServerTurnStartLiveSendReceiptLink,
    pub authority: CodexAppServerTransportExecutorAuthorityRecord,
    pub payload_ref: CodexAppServerTurnStartStdioPayloadRef,
}

/// Reference to provider payload material without retaining that material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartStdioPayloadRef {
    pub payload_ref: String,
    pub summary: String,
    pub raw_payload_retained: bool,
}

/// Sanitized handoff envelope for the stdio transport executor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartStdioExecutionEnvelopeRecord {
    pub envelope_id: CodexAppServerTurnStartStdioExecutionEnvelopeId,
    pub request_id: String,
    pub method: String,
    pub provider_instance_id: String,
    pub service_id: Option<ProviderServiceId>,
    pub send_command_id: String,
    pub preflight_id: String,
    pub write_attempt_id: String,
    pub receipt_id: String,
    pub event_id: OrchestrationEventId,
    pub authority_id: String,
    pub idempotency_key: String,
    pub payload_ref: CodexAppServerTurnStartStdioPayloadRef,
    pub target: ProviderTransportWriteTarget,
    pub status: CodexAppServerTurnStartStdioExecutionEnvelopeStatus,
    pub blockers: Vec<CodexAppServerTurnStartStdioExecutionEnvelopeBlocker>,
    pub evidence_refs: Vec<String>,
    pub provider_write_executed: bool,
    pub raw_payload_retained: bool,
    pub raw_stream_retained: bool,
    pub callback_response_permitted: bool,
    pub cancellation_permitted: bool,
    pub task_mutation_permitted: bool,
}

/// Execution-envelope status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartStdioExecutionEnvelopeStatus {
    ReadyForExecutorHandoff,
    Blocked,
}

/// Why the execution envelope cannot be handed off.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartStdioExecutionEnvelopeBlocker {
    AuthorityNotReady,
    SendCommandAlreadyStartedProviderWrite,
    SendCommandTargetNotStdio,
    WriteAttemptTargetNotStdio,
    ReceiptLinkBlocked,
    RawPayloadRetained,
    RawStreamRetentionNotAllowed,
    MethodNotTurnStart,
    PreflightIdentityMismatch,
    WriteAttemptIdentityMismatch,
    ReceiptIdentityMismatch,
    EnvelopeIdentityMismatch,
    EmptyPayloadRef,
    EmptyIdempotencyKey,
}
