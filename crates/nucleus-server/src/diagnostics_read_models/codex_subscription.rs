use serde::{Deserialize, Serialize};

use crate::{
    codex_receipt_from_stdio_write_state, codex_receipt_from_subscription_state,
    CodexAppServerStdioWriteState, CodexAppServerStdioWriteStateRecord,
    CodexAppServerSubscriptionState, CodexAppServerSubscriptionStateRecord,
};

use super::helpers::{source_status, source_summary};

/// Client-safe diagnostics for Codex send/subscription state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CodexSubscriptionDiagnosticsDto {
    pub writes: Vec<CodexStdioWriteDiagnosticDto>,
    pub subscriptions: Vec<CodexSubscriptionDiagnosticDto>,
    pub client_can_write_provider: bool,
    pub client_can_answer_callbacks: bool,
    pub client_can_cancel_provider: bool,
    pub client_can_mutate_tasks: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CodexStdioWriteDiagnosticDto {
    pub write_id: String,
    pub command_id: String,
    pub envelope_id: String,
    pub request_id: String,
    pub method: String,
    pub state: String,
    pub receipt_id: String,
    pub evidence_refs: Vec<String>,
    pub raw_payload_retained: bool,
    pub raw_stream_retained: bool,
    pub next_action: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CodexSubscriptionDiagnosticDto {
    pub subscription_id: String,
    pub command_id: String,
    pub envelope_id: String,
    pub request_id: String,
    pub state: String,
    pub receipt_id: String,
    pub evidence_refs: Vec<String>,
    pub raw_stream_retained: bool,
    pub callback_response_permitted: bool,
    pub cancellation_permitted: bool,
    pub task_mutation_permitted: bool,
    pub next_action: String,
}

pub fn codex_subscription_diagnostics(
    writes: &[CodexAppServerStdioWriteStateRecord],
    subscriptions: &[CodexAppServerSubscriptionStateRecord],
) -> CodexSubscriptionDiagnosticsDto {
    let count = writes.len() + subscriptions.len();
    CodexSubscriptionDiagnosticsDto {
        writes: writes
            .iter()
            .map(CodexStdioWriteDiagnosticDto::from)
            .collect(),
        subscriptions: subscriptions
            .iter()
            .map(CodexSubscriptionDiagnosticDto::from)
            .collect(),
        client_can_write_provider: false,
        client_can_answer_callbacks: false,
        client_can_cancel_provider: false,
        client_can_mutate_tasks: false,
        source_status: source_status(count),
        source_summary: Some(source_summary(
            count,
            "Codex send/subscription diagnostics have no records yet",
            "Codex send/subscription diagnostics loaded from sanitized records",
        )),
    }
}

impl From<&CodexAppServerStdioWriteStateRecord> for CodexStdioWriteDiagnosticDto {
    fn from(record: &CodexAppServerStdioWriteStateRecord) -> Self {
        let receipt = codex_receipt_from_stdio_write_state(record);
        Self {
            write_id: record.write_id.0.clone(),
            command_id: record.command_id.clone(),
            envelope_id: record.envelope_id.clone(),
            request_id: record.request_id.clone(),
            method: record.method.clone(),
            state: write_state(&record.state),
            receipt_id: receipt.receipt_id.0,
            evidence_refs: record.evidence_refs.clone(),
            raw_payload_retained: record.raw_payload_retained,
            raw_stream_retained: record.raw_stream_retained,
            next_action: write_next_action(&record.state),
        }
    }
}

impl From<&CodexAppServerSubscriptionStateRecord> for CodexSubscriptionDiagnosticDto {
    fn from(record: &CodexAppServerSubscriptionStateRecord) -> Self {
        let receipt = codex_receipt_from_subscription_state(record);
        Self {
            subscription_id: record.subscription_id.0.clone(),
            command_id: record.command_id.clone(),
            envelope_id: record.envelope_id.clone(),
            request_id: record.request_id.clone(),
            state: subscription_state(&record.state),
            receipt_id: receipt.receipt_id.0,
            evidence_refs: record.evidence_refs.clone(),
            raw_stream_retained: record.raw_stream_retained,
            callback_response_permitted: record.callback_response_permitted,
            cancellation_permitted: record.cancellation_permitted,
            task_mutation_permitted: record.task_mutation_permitted,
            next_action: subscription_next_action(&record.state),
        }
    }
}

fn write_state(state: &CodexAppServerStdioWriteState) -> String {
    match state {
        CodexAppServerStdioWriteState::Queued => "queued",
        CodexAppServerStdioWriteState::Written => "written",
        CodexAppServerStdioWriteState::Blocked(_) => "blocked",
        CodexAppServerStdioWriteState::Failed(_) => "failed",
    }
    .to_owned()
}

fn subscription_state(state: &CodexAppServerSubscriptionState) -> String {
    match state {
        CodexAppServerSubscriptionState::Pending => "pending",
        CodexAppServerSubscriptionState::Open => "open",
        CodexAppServerSubscriptionState::Closed => "closed",
        CodexAppServerSubscriptionState::Blocked(_) => "blocked",
        CodexAppServerSubscriptionState::Failed(_) => "failed",
        CodexAppServerSubscriptionState::RecoveryRequired(_) => "recovery_required",
    }
    .to_owned()
}

fn write_next_action(state: &CodexAppServerStdioWriteState) -> String {
    match state {
        CodexAppServerStdioWriteState::Queued => "await_write_result",
        CodexAppServerStdioWriteState::Written => "await_subscription_events",
        CodexAppServerStdioWriteState::Blocked(_) => "repair_write_gate",
        CodexAppServerStdioWriteState::Failed(_) => "inspect_write_failure",
    }
    .to_owned()
}

fn subscription_next_action(state: &CodexAppServerSubscriptionState) -> String {
    match state {
        CodexAppServerSubscriptionState::Pending => "await_subscription_open",
        CodexAppServerSubscriptionState::Open => "ingest_provider_events",
        CodexAppServerSubscriptionState::Closed => "none",
        CodexAppServerSubscriptionState::Blocked(_) => "repair_subscription_gate",
        CodexAppServerSubscriptionState::Failed(_) => "inspect_subscription_failure",
        CodexAppServerSubscriptionState::RecoveryRequired(_) => "repair_or_recover_session",
    }
    .to_owned()
}
