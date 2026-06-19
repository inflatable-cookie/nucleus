//! Codex live executor outcome records.
//!
//! These records summarize an operator-confirmed live Codex app-server
//! executor attempt. They preserve replay and diagnostics identity while
//! excluding raw prompts, provider responses, frames, stdout, stderr, and
//! stream deltas.

use serde::{Deserialize, Serialize};

/// Stable id for one Codex live executor outcome record.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct CodexAppServerLiveExecutorOutcomeId(pub String);

/// Supported transport for the live executor attempt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexAppServerLiveExecutorTransportKind {
    Stdio,
}

/// Sanitized method/protocol milestones observed by the live executor.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexAppServerLiveExecutorMethod {
    Initialize,
    InitializedNotification,
    ThreadStart,
    TurnStart,
    TurnCompleted,
    Cleanup,
}

/// Final attempt state for one live executor run.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "status", content = "detail", rename_all = "snake_case")]
pub enum CodexAppServerLiveExecutorOutcomeStatus {
    Accepted,
    Completed,
    Failed(String),
    TimedOut,
    Blocked(String),
    CleanupRequired(String),
}

/// Cleanup result after an executor attempt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "status", content = "detail", rename_all = "snake_case")]
pub enum CodexAppServerLiveExecutorCleanupStatus {
    NotRequired,
    Completed,
    Failed(String),
    Unknown,
}

/// Sanitized live executor outcome record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CodexAppServerLiveExecutorOutcomeRecord {
    pub outcome_id: CodexAppServerLiveExecutorOutcomeId,
    pub provider_instance_id: String,
    pub transport_kind: CodexAppServerLiveExecutorTransportKind,
    pub write_attempt_id: String,
    pub receipt_refs: Vec<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub final_turn_status: Option<String>,
    pub status: CodexAppServerLiveExecutorOutcomeStatus,
    pub method_sequence: Vec<CodexAppServerLiveExecutorMethod>,
    pub notification_count: usize,
    pub server_request_count: usize,
    pub cleanup_status: CodexAppServerLiveExecutorCleanupStatus,
    pub evidence_refs: Vec<String>,
    pub provider_write_executed: bool,
    pub raw_payload_retained: bool,
    pub raw_stream_retained: bool,
    pub task_mutation_permitted: bool,
    pub callback_response_permitted: bool,
    pub cancellation_permitted: bool,
    pub resume_permitted: bool,
}

/// Input for building a sanitized live executor outcome record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerLiveExecutorOutcomeInput {
    pub provider_instance_id: String,
    pub write_attempt_id: String,
    pub receipt_refs: Vec<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub final_turn_status: Option<String>,
    pub status: CodexAppServerLiveExecutorOutcomeStatus,
    pub method_sequence: Vec<CodexAppServerLiveExecutorMethod>,
    pub notification_count: usize,
    pub server_request_count: usize,
    pub cleanup_status: CodexAppServerLiveExecutorCleanupStatus,
    pub evidence_refs: Vec<String>,
    pub provider_write_executed: bool,
}

/// Why a live executor outcome record is invalid.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerLiveExecutorOutcomeValidationError {
    MissingProviderInstanceId,
    MissingWriteAttemptId,
    MissingEvidenceRef,
    MissingReceiptRef,
    MissingMethodSequence,
    MissingThreadId,
    MissingTurnId,
    MissingFinalTurnStatus,
    CompletedWithoutProviderWrite,
    CompletedWithoutRequiredMethod(CodexAppServerLiveExecutorMethod),
    RawPayloadRetained,
    RawStreamRetained,
    TaskMutationPermitted,
    CallbackResponsePermitted,
    CancellationPermitted,
    ResumePermitted,
}

/// Build a live executor outcome record with forbidden authorities disabled.
pub fn codex_live_executor_outcome_record(
    input: CodexAppServerLiveExecutorOutcomeInput,
) -> CodexAppServerLiveExecutorOutcomeRecord {
    let status_label = live_executor_status_label(&input.status);
    CodexAppServerLiveExecutorOutcomeRecord {
        outcome_id: CodexAppServerLiveExecutorOutcomeId(format!(
            "codex-live-executor-outcome:{}:{status_label}",
            input.write_attempt_id
        )),
        provider_instance_id: input.provider_instance_id,
        transport_kind: CodexAppServerLiveExecutorTransportKind::Stdio,
        write_attempt_id: input.write_attempt_id,
        receipt_refs: unique_sorted(input.receipt_refs),
        thread_id: input.thread_id,
        turn_id: input.turn_id,
        final_turn_status: input.final_turn_status,
        status: input.status,
        method_sequence: input.method_sequence,
        notification_count: input.notification_count,
        server_request_count: input.server_request_count,
        cleanup_status: input.cleanup_status,
        evidence_refs: unique_sorted(input.evidence_refs),
        provider_write_executed: input.provider_write_executed,
        raw_payload_retained: false,
        raw_stream_retained: false,
        task_mutation_permitted: false,
        callback_response_permitted: false,
        cancellation_permitted: false,
        resume_permitted: false,
    }
}

/// Validate the live executor outcome record's authority and identity shape.
pub fn validate_codex_live_executor_outcome_record(
    record: &CodexAppServerLiveExecutorOutcomeRecord,
) -> Result<(), Vec<CodexAppServerLiveExecutorOutcomeValidationError>> {
    let mut errors = Vec::new();

    if record.provider_instance_id.is_empty() {
        errors.push(CodexAppServerLiveExecutorOutcomeValidationError::MissingProviderInstanceId);
    }
    if record.write_attempt_id.is_empty() {
        errors.push(CodexAppServerLiveExecutorOutcomeValidationError::MissingWriteAttemptId);
    }
    if record.evidence_refs.is_empty() {
        errors.push(CodexAppServerLiveExecutorOutcomeValidationError::MissingEvidenceRef);
    }
    if record.receipt_refs.is_empty() {
        errors.push(CodexAppServerLiveExecutorOutcomeValidationError::MissingReceiptRef);
    }
    if record.method_sequence.is_empty() {
        errors.push(CodexAppServerLiveExecutorOutcomeValidationError::MissingMethodSequence);
    }

    validate_forbidden_authority(record, &mut errors);
    validate_completed_outcome(record, &mut errors);

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

fn validate_forbidden_authority(
    record: &CodexAppServerLiveExecutorOutcomeRecord,
    errors: &mut Vec<CodexAppServerLiveExecutorOutcomeValidationError>,
) {
    if record.raw_payload_retained {
        errors.push(CodexAppServerLiveExecutorOutcomeValidationError::RawPayloadRetained);
    }
    if record.raw_stream_retained {
        errors.push(CodexAppServerLiveExecutorOutcomeValidationError::RawStreamRetained);
    }
    if record.task_mutation_permitted {
        errors.push(CodexAppServerLiveExecutorOutcomeValidationError::TaskMutationPermitted);
    }
    if record.callback_response_permitted {
        errors.push(CodexAppServerLiveExecutorOutcomeValidationError::CallbackResponsePermitted);
    }
    if record.cancellation_permitted {
        errors.push(CodexAppServerLiveExecutorOutcomeValidationError::CancellationPermitted);
    }
    if record.resume_permitted {
        errors.push(CodexAppServerLiveExecutorOutcomeValidationError::ResumePermitted);
    }
}

fn validate_completed_outcome(
    record: &CodexAppServerLiveExecutorOutcomeRecord,
    errors: &mut Vec<CodexAppServerLiveExecutorOutcomeValidationError>,
) {
    if record.status != CodexAppServerLiveExecutorOutcomeStatus::Completed {
        return;
    }

    if record.thread_id.as_deref().unwrap_or_default().is_empty() {
        errors.push(CodexAppServerLiveExecutorOutcomeValidationError::MissingThreadId);
    }
    if record.turn_id.as_deref().unwrap_or_default().is_empty() {
        errors.push(CodexAppServerLiveExecutorOutcomeValidationError::MissingTurnId);
    }
    if record
        .final_turn_status
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        errors.push(CodexAppServerLiveExecutorOutcomeValidationError::MissingFinalTurnStatus);
    }
    if !record.provider_write_executed {
        errors
            .push(CodexAppServerLiveExecutorOutcomeValidationError::CompletedWithoutProviderWrite);
    }

    for method in completed_required_methods() {
        if !record.method_sequence.contains(&method) {
            errors.push(
                CodexAppServerLiveExecutorOutcomeValidationError::CompletedWithoutRequiredMethod(
                    method,
                ),
            );
        }
    }
}

fn completed_required_methods() -> Vec<CodexAppServerLiveExecutorMethod> {
    vec![
        CodexAppServerLiveExecutorMethod::Initialize,
        CodexAppServerLiveExecutorMethod::InitializedNotification,
        CodexAppServerLiveExecutorMethod::ThreadStart,
        CodexAppServerLiveExecutorMethod::TurnStart,
        CodexAppServerLiveExecutorMethod::TurnCompleted,
        CodexAppServerLiveExecutorMethod::Cleanup,
    ]
}

fn live_executor_status_label(status: &CodexAppServerLiveExecutorOutcomeStatus) -> &'static str {
    match status {
        CodexAppServerLiveExecutorOutcomeStatus::Accepted => "accepted",
        CodexAppServerLiveExecutorOutcomeStatus::Completed => "completed",
        CodexAppServerLiveExecutorOutcomeStatus::Failed(_) => "failed",
        CodexAppServerLiveExecutorOutcomeStatus::TimedOut => "timed-out",
        CodexAppServerLiveExecutorOutcomeStatus::Blocked(_) => "blocked",
        CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(_) => "cleanup-required",
    }
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests;
