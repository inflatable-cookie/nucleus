use serde::{Deserialize, Serialize};

use crate::{
    CodexAppServerLiveExecutorCleanupStatus, CodexAppServerLiveExecutorMethod,
    CodexAppServerLiveExecutorOutcomeRecord, CodexAppServerLiveExecutorOutcomeStatus,
};

use super::helpers::{source_status, source_summary};

/// Client-safe diagnostics for persisted Codex live executor outcomes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CodexLiveExecutorDiagnosticsDto {
    pub attempts: Vec<CodexLiveExecutorAttemptDiagnosticDto>,
    pub client_can_execute_provider_write: bool,
    pub client_can_answer_callbacks: bool,
    pub client_can_cancel_provider: bool,
    pub client_can_resume_provider: bool,
    pub client_can_mutate_tasks: bool,
    pub provider_material_exposed: bool,
    pub stream_material_exposed: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

/// One live executor attempt visible to diagnostics clients.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CodexLiveExecutorAttemptDiagnosticDto {
    pub outcome_id: String,
    pub provider_instance_id: String,
    pub write_attempt_id: String,
    pub receipt_refs: Vec<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub final_turn_status: Option<String>,
    pub status: String,
    pub method_sequence: Vec<String>,
    pub notification_count: usize,
    pub server_request_count: usize,
    pub cleanup_status: String,
    pub evidence_refs: Vec<String>,
    pub provider_write_executed: bool,
    pub task_mutation_permitted: bool,
    pub callback_response_permitted: bool,
    pub cancellation_permitted: bool,
    pub resume_permitted: bool,
    pub next_action: String,
}

pub fn codex_live_executor_diagnostics(
    records: &[CodexAppServerLiveExecutorOutcomeRecord],
) -> CodexLiveExecutorDiagnosticsDto {
    CodexLiveExecutorDiagnosticsDto {
        attempts: records
            .iter()
            .map(CodexLiveExecutorAttemptDiagnosticDto::from)
            .collect(),
        client_can_execute_provider_write: false,
        client_can_answer_callbacks: false,
        client_can_cancel_provider: false,
        client_can_resume_provider: false,
        client_can_mutate_tasks: false,
        provider_material_exposed: false,
        stream_material_exposed: false,
        source_status: source_status(records.len()),
        source_summary: Some(source_summary(
            records.len(),
            "Codex live executor diagnostics have no records yet",
            "Codex live executor diagnostics loaded from sanitized outcomes",
        )),
    }
}

impl From<&CodexAppServerLiveExecutorOutcomeRecord> for CodexLiveExecutorAttemptDiagnosticDto {
    fn from(record: &CodexAppServerLiveExecutorOutcomeRecord) -> Self {
        Self {
            outcome_id: record.outcome_id.0.clone(),
            provider_instance_id: record.provider_instance_id.clone(),
            write_attempt_id: record.write_attempt_id.clone(),
            receipt_refs: record.receipt_refs.clone(),
            thread_id: record.thread_id.clone(),
            turn_id: record.turn_id.clone(),
            final_turn_status: record.final_turn_status.clone(),
            status: outcome_status(&record.status),
            method_sequence: record
                .method_sequence
                .iter()
                .map(method_label)
                .collect::<Vec<_>>(),
            notification_count: record.notification_count,
            server_request_count: record.server_request_count,
            cleanup_status: cleanup_status(&record.cleanup_status),
            evidence_refs: record.evidence_refs.clone(),
            provider_write_executed: record.provider_write_executed,
            task_mutation_permitted: record.task_mutation_permitted,
            callback_response_permitted: record.callback_response_permitted,
            cancellation_permitted: record.cancellation_permitted,
            resume_permitted: record.resume_permitted,
            next_action: next_action(&record.status),
        }
    }
}

fn outcome_status(status: &CodexAppServerLiveExecutorOutcomeStatus) -> String {
    match status {
        CodexAppServerLiveExecutorOutcomeStatus::Accepted => "accepted",
        CodexAppServerLiveExecutorOutcomeStatus::Completed => "completed",
        CodexAppServerLiveExecutorOutcomeStatus::Failed(_) => "failed",
        CodexAppServerLiveExecutorOutcomeStatus::TimedOut => "timed_out",
        CodexAppServerLiveExecutorOutcomeStatus::Blocked(_) => "blocked",
        CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(_) => "cleanup_required",
    }
    .to_owned()
}

fn cleanup_status(status: &CodexAppServerLiveExecutorCleanupStatus) -> String {
    match status {
        CodexAppServerLiveExecutorCleanupStatus::NotRequired => "not_required",
        CodexAppServerLiveExecutorCleanupStatus::Completed => "completed",
        CodexAppServerLiveExecutorCleanupStatus::Failed(_) => "failed",
        CodexAppServerLiveExecutorCleanupStatus::Unknown => "unknown",
    }
    .to_owned()
}

fn method_label(method: &CodexAppServerLiveExecutorMethod) -> String {
    match method {
        CodexAppServerLiveExecutorMethod::Initialize => "initialize",
        CodexAppServerLiveExecutorMethod::InitializedNotification => "initialized_notification",
        CodexAppServerLiveExecutorMethod::ThreadStart => "thread_start",
        CodexAppServerLiveExecutorMethod::TurnStart => "turn_start",
        CodexAppServerLiveExecutorMethod::TurnCompleted => "turn_completed",
        CodexAppServerLiveExecutorMethod::Cleanup => "cleanup",
    }
    .to_owned()
}

fn next_action(status: &CodexAppServerLiveExecutorOutcomeStatus) -> String {
    match status {
        CodexAppServerLiveExecutorOutcomeStatus::Accepted => "watch_for_completion",
        CodexAppServerLiveExecutorOutcomeStatus::Completed => "inspect_receipt_and_evidence",
        CodexAppServerLiveExecutorOutcomeStatus::Failed(_) => "inspect_failure_evidence",
        CodexAppServerLiveExecutorOutcomeStatus::TimedOut => "review_timeout_and_cleanup",
        CodexAppServerLiveExecutorOutcomeStatus::Blocked(_) => "repair_executor_gate",
        CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(_) => "run_cleanup_or_repair_host",
    }
    .to_owned()
}
