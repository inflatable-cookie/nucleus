use serde::{Deserialize, Serialize};

use crate::{
    CodexAppServerDecodeOutcomePersistenceRecord, CodexAppServerStdioDecodeStatus,
    CodexAppServerStdioFrameIngestionPersistenceRecord,
    CodexAppServerTransportExecutorAuthorityRecord, CodexAppServerTransportExecutorAuthorityStatus,
    CodexAppServerTurnStartStdioExecutionEnvelopeRecord,
    CodexAppServerTurnStartStdioExecutionEnvelopeStatus,
    CodexAppServerTurnStartTransportExecutionPersistenceRecord, ProviderSessionBindingRecord,
    ProviderSessionRepairState,
};
use nucleus_engine::{EngineRuntimeReceiptRecord, EngineRuntimeReceiptStatus};

use super::helpers::{source_status, source_summary};

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

pub fn codex_transport_executor_diagnostics(
    sessions: &[ProviderSessionBindingRecord],
    authorities: &[CodexAppServerTransportExecutorAuthorityRecord],
    envelopes: &[CodexAppServerTurnStartStdioExecutionEnvelopeRecord],
    executions: &[CodexAppServerTurnStartTransportExecutionPersistenceRecord],
    frames: &[CodexAppServerStdioFrameIngestionPersistenceRecord],
    decode_outcomes: &[CodexAppServerDecodeOutcomePersistenceRecord],
    transport_receipts: &[EngineRuntimeReceiptRecord],
) -> CodexTransportExecutorDiagnosticsDto {
    let count = sessions.len()
        + authorities.len()
        + envelopes.len()
        + executions.len()
        + frames.len()
        + decode_outcomes.len()
        + transport_receipts.len();
    let repair_required_count = sessions
        .iter()
        .filter(|record| session_repair_required(&record.repair_state))
        .count()
        + transport_receipts
            .iter()
            .filter(|record| record.status == EngineRuntimeReceiptStatus::RecoveryRequired)
            .count();

    CodexTransportExecutorDiagnosticsDto {
        sessions: sessions
            .iter()
            .map(CodexTransportSessionDiagnosticDto::from)
            .collect(),
        authorities: authorities
            .iter()
            .map(CodexTransportExecutorAuthorityDiagnosticDto::from)
            .collect(),
        envelopes: envelopes
            .iter()
            .map(CodexTransportExecutorEnvelopeDiagnosticDto::from)
            .collect(),
        executions: executions
            .iter()
            .map(CodexTransportExecutionDiagnosticDto::from)
            .collect(),
        frames: frames
            .iter()
            .map(CodexStdioFrameIngestionDiagnosticDto::from)
            .collect(),
        decode_outcomes: decode_outcomes
            .iter()
            .map(CodexDecodeOutcomeDiagnosticDto::from)
            .collect(),
        transport_receipts: transport_receipts
            .iter()
            .map(CodexTransportReceiptDiagnosticDto::from)
            .collect(),
        session_count: sessions.len(),
        frame_count: frames.len(),
        decode_outcome_count: decode_outcomes.len(),
        receipt_count: transport_receipts.len(),
        repair_required_count,
        client_can_execute_provider_write: false,
        client_can_answer_callbacks: false,
        client_can_cancel_provider: false,
        client_can_mutate_tasks: false,
        provider_material_exposed: false,
        raw_streams_exposed: false,
        source_status: source_status(count),
        source_summary: Some(source_summary(
            count,
            "Codex transport executor diagnostics have no records yet",
            "Codex transport executor diagnostics loaded from sanitized records",
        )),
    }
}

impl From<&ProviderSessionBindingRecord> for CodexTransportSessionDiagnosticDto {
    fn from(record: &ProviderSessionBindingRecord) -> Self {
        let repair_required = session_repair_required(&record.repair_state);
        Self {
            binding_id: record.binding_id.0.clone(),
            provider_instance_id: record.provider_instance_id.clone(),
            provider_service_id: record.provider_service_id.clone(),
            runtime_session_ref: record.runtime_session_ref.clone(),
            provider_session_ref: record.provider_session_ref.clone(),
            provider_thread_ref: record.provider_thread_ref.clone(),
            lifecycle_state: format!("{:?}", record.lifecycle_state),
            evidence_refs: record.evidence_refs.clone(),
            repair_state: format!("{:?}", record.repair_state),
            repair_required,
            provider_write_permitted: record.provider_write_permitted,
            raw_provider_material_retained: record.raw_provider_material_retained,
            task_mutation_permitted: record.task_mutation_permitted,
            next_action: if repair_required {
                "repair_provider_session_binding"
            } else {
                "inspect_session_frame_receipts"
            }
            .to_owned(),
        }
    }
}

impl From<&CodexAppServerTransportExecutorAuthorityRecord>
    for CodexTransportExecutorAuthorityDiagnosticDto
{
    fn from(record: &CodexAppServerTransportExecutorAuthorityRecord) -> Self {
        Self {
            authority_id: record.authority_id.0.clone(),
            provider_instance_id: record.provider_instance_id.clone(),
            preflight_id: record.preflight_id.clone(),
            write_attempt_id: record.write_attempt_id.clone(),
            status: authority_status(&record.status),
            blockers: record
                .blockers
                .iter()
                .map(|blocker| format!("{blocker:?}"))
                .collect(),
            evidence_refs: record.evidence_refs.clone(),
            task_mutation_permitted: record.task_mutation_permitted,
            next_action: authority_next_action(&record.status),
        }
    }
}

impl From<&CodexAppServerTurnStartStdioExecutionEnvelopeRecord>
    for CodexTransportExecutorEnvelopeDiagnosticDto
{
    fn from(record: &CodexAppServerTurnStartStdioExecutionEnvelopeRecord) -> Self {
        Self {
            envelope_id: record.envelope_id.0.clone(),
            request_id: record.request_id.clone(),
            send_command_id: record.send_command_id.clone(),
            write_attempt_id: record.write_attempt_id.clone(),
            status: envelope_status(&record.status),
            blockers: record
                .blockers
                .iter()
                .map(|blocker| format!("{blocker:?}"))
                .collect(),
            receipt_id: record.receipt_id.clone(),
            event_id: record.event_id.0.clone(),
            evidence_refs: record.evidence_refs.clone(),
            raw_payload_retained: record.raw_payload_retained,
            raw_stream_retained: record.raw_stream_retained,
            task_mutation_permitted: record.task_mutation_permitted,
            next_action: envelope_next_action(&record.status),
        }
    }
}

impl From<&CodexAppServerTurnStartTransportExecutionPersistenceRecord>
    for CodexTransportExecutionDiagnosticDto
{
    fn from(record: &CodexAppServerTurnStartTransportExecutionPersistenceRecord) -> Self {
        Self {
            execution_id: record.execution_id.clone(),
            write_attempt_id: record.write_attempt_id.clone(),
            idempotency_key: record.idempotency_key.clone(),
            receipt_id: record.receipt_id.0.clone(),
            event_id: record.event_id.as_ref().map(|event_id| event_id.0.clone()),
            replay_policy: "inspect_only".to_owned(),
            provider_write_executed: record.provider_write_executed,
            raw_payload_persisted: record.raw_payload_persisted,
            raw_stream_persisted: record.raw_stream_persisted,
            task_mutation_permitted: record.task_mutation_permitted,
            next_action: "inspect_receipt_and_frame_evidence".to_owned(),
        }
    }
}

impl From<&CodexAppServerStdioFrameIngestionPersistenceRecord>
    for CodexStdioFrameIngestionDiagnosticDto
{
    fn from(record: &CodexAppServerStdioFrameIngestionPersistenceRecord) -> Self {
        Self {
            ingestion_id: record.ingestion_id.clone(),
            frame_source_id: record.frame_source_id.clone(),
            runtime_instance_id: record.runtime_instance_id.clone(),
            sequence: record.sequence,
            decode_status: format!("{:?}", record.decode_status),
            receipt_id: record.receipt_id.0.clone(),
            observation_event_id: record
                .observation_event_id
                .as_ref()
                .map(|event_id| event_id.0.clone()),
            evidence_refs: record.evidence_refs.clone(),
            raw_payload_retained: record.raw_payload_retained,
            raw_stream_retained: record.raw_stream_retained,
            task_mutation_permitted: record.task_mutation_permitted,
            next_action: if record.observation_event_id.is_some() {
                "inspect_observation_event"
            } else {
                "inspect_decode_receipt"
            }
            .to_owned(),
        }
    }
}

impl From<&CodexAppServerDecodeOutcomePersistenceRecord> for CodexDecodeOutcomeDiagnosticDto {
    fn from(record: &CodexAppServerDecodeOutcomePersistenceRecord) -> Self {
        Self {
            outcome_id: record.outcome_id.clone(),
            frame_source_id: record.frame_source_id.clone(),
            runtime_instance_id: record.runtime_instance_id.clone(),
            sequence: record.sequence,
            decode_status: format!("{:?}", record.decode_status),
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
            next_action: decode_outcome_next_action(record),
        }
    }
}

impl From<&EngineRuntimeReceiptRecord> for CodexTransportReceiptDiagnosticDto {
    fn from(record: &EngineRuntimeReceiptRecord) -> Self {
        Self {
            receipt_id: record.receipt_id.0.clone(),
            status: format!("{:?}", record.status),
            family: format!("{:?}", record.family),
            command_ref: record
                .command_ref
                .as_ref()
                .map(|value| format!("{value:?}")),
            effect_ref: record.effect_ref.as_ref().map(|value| format!("{value:?}")),
            evidence_refs: record
                .evidence_refs
                .iter()
                .map(|value| format!("{value:?}"))
                .collect(),
            artifact_refs: record
                .artifact_refs
                .iter()
                .map(|value| format!("{value:?}"))
                .collect(),
            summary: record.summary.clone(),
            recovery_required: record.status == EngineRuntimeReceiptStatus::RecoveryRequired,
            provider_material_exposed: false,
            client_can_replay_effect: false,
            next_action: receipt_next_action(&record.status),
        }
    }
}

fn session_repair_required(state: &ProviderSessionRepairState) -> bool {
    !matches!(state, ProviderSessionRepairState::Healthy)
}

fn decode_outcome_next_action(record: &CodexAppServerDecodeOutcomePersistenceRecord) -> String {
    match &record.decode_status {
        CodexAppServerStdioDecodeStatus::Decoded { .. } => "inspect_observation_event",
        CodexAppServerStdioDecodeStatus::Malformed { .. } => "inspect_parse_failure",
        CodexAppServerStdioDecodeStatus::Unsupported { .. } => "inspect_unsupported_method",
        CodexAppServerStdioDecodeStatus::RecoveryRequired { .. } => {
            "repair_provider_session_binding"
        }
    }
    .to_owned()
}

fn receipt_next_action(status: &EngineRuntimeReceiptStatus) -> String {
    match status {
        EngineRuntimeReceiptStatus::RecoveryRequired => "inspect_recovery_requirement",
        EngineRuntimeReceiptStatus::Failed => "inspect_failed_receipt",
        EngineRuntimeReceiptStatus::Blocked => "inspect_blocked_receipt",
        _ => "inspect_receipt_evidence",
    }
    .to_owned()
}

fn authority_status(status: &CodexAppServerTransportExecutorAuthorityStatus) -> String {
    match status {
        CodexAppServerTransportExecutorAuthorityStatus::ReadyForExecutionHandoff => "ready",
        CodexAppServerTransportExecutorAuthorityStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn authority_next_action(status: &CodexAppServerTransportExecutorAuthorityStatus) -> String {
    match status {
        CodexAppServerTransportExecutorAuthorityStatus::ReadyForExecutionHandoff => {
            "prepare_sanitized_execution_envelope"
        }
        CodexAppServerTransportExecutorAuthorityStatus::Blocked => "repair_executor_authority",
    }
    .to_owned()
}

fn envelope_status(status: &CodexAppServerTurnStartStdioExecutionEnvelopeStatus) -> String {
    match status {
        CodexAppServerTurnStartStdioExecutionEnvelopeStatus::ReadyForExecutorHandoff => "ready",
        CodexAppServerTurnStartStdioExecutionEnvelopeStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn envelope_next_action(status: &CodexAppServerTurnStartStdioExecutionEnvelopeStatus) -> String {
    match status {
        CodexAppServerTurnStartStdioExecutionEnvelopeStatus::ReadyForExecutorHandoff => {
            "persist_transport_execution_attempt"
        }
        CodexAppServerTurnStartStdioExecutionEnvelopeStatus::Blocked => {
            "inspect_execution_envelope_blockers"
        }
    }
    .to_owned()
}
