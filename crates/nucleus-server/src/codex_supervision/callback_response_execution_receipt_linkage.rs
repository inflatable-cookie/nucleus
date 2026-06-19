//! Callback response execution receipt linkage records.
//!
//! These records link admitted callback response writes to sanitized executor
//! outcomes and runtime receipts. They record provider progress without
//! accepting review, completing tasks, retaining raw callback material, or
//! granting further provider authority.

use super::{
    CodexAppServerCallbackResponseExecutorAdmissionRecord,
    CodexAppServerCallbackResponseExecutorAdmissionStatus, CodexAppServerLiveExecutorOutcomeRecord,
    CodexAppServerLiveExecutorOutcomeStatus,
};

use nucleus_engine::EngineRuntimeReceiptRecordId;

/// Stable id for one callback response execution receipt linkage record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerCallbackResponseExecutionReceiptLinkId(pub String);

/// Link status for a callback response execution attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerCallbackResponseExecutionReceiptLinkStatus {
    Linked,
    Blocked(Vec<CodexAppServerCallbackResponseExecutionReceiptLinkBlocker>),
}

/// Runtime progress derived from a callback response executor outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerCallbackResponseExecutionRuntimeProgress {
    Accepted,
    Completed,
    Failed(String),
    TimedOut,
    Blocked(String),
    CleanupRequired(String),
}

/// Why callback response execution receipt linkage cannot be trusted.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerCallbackResponseExecutionReceiptLinkBlocker {
    AdmissionNotAccepted,
    MissingOutcomeId,
    MissingRuntimeReceiptId,
    MissingProviderInstanceId,
    MissingWriteAttemptId,
    ProviderInstanceMismatch,
    WriteAttemptMismatch,
    OutcomeRetainedRawPayload,
    OutcomeRetainedRawStream,
    OutcomePermitsTaskMutation,
    AdmissionRetainedRawCallbackMaterial,
    AdmissionPermitsTaskMutation,
    AdmissionPermitsReviewAcceptance,
}

/// Reference-only linkage from callback response execution to a runtime receipt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerCallbackResponseExecutionReceiptLink {
    pub link_id: CodexAppServerCallbackResponseExecutionReceiptLinkId,
    pub admission_id: String,
    pub policy_id: String,
    pub request_id: String,
    pub callback_response_id: String,
    pub envelope_id: String,
    pub provider_callback_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub live_executor_outcome_id: String,
    pub runtime_receipt_id: EngineRuntimeReceiptRecordId,
    pub provider_instance_id: String,
    pub callback_response_write_attempt_id: String,
    pub runtime_progress: CodexAppServerCallbackResponseExecutionRuntimeProgress,
    pub status: CodexAppServerCallbackResponseExecutionReceiptLinkStatus,
    pub callback_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub provider_completion_recorded: bool,
    pub provider_write_recorded: bool,
    pub task_completion_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub raw_callback_material_retained: bool,
}

/// Build reference-only callback response execution receipt linkage.
pub fn codex_callback_response_execution_receipt_link(
    admission: &CodexAppServerCallbackResponseExecutorAdmissionRecord,
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
    runtime_receipt_id: EngineRuntimeReceiptRecordId,
) -> CodexAppServerCallbackResponseExecutionReceiptLink {
    let blockers = receipt_link_blockers(admission, outcome, &runtime_receipt_id);
    let status = if blockers.is_empty() {
        CodexAppServerCallbackResponseExecutionReceiptLinkStatus::Linked
    } else {
        CodexAppServerCallbackResponseExecutionReceiptLinkStatus::Blocked(blockers)
    };
    let runtime_progress = runtime_progress_from_outcome(&outcome.status);
    let callback_refs = callback_refs(admission, outcome, &runtime_receipt_id);
    let evidence_refs = evidence_refs(admission, outcome);

    CodexAppServerCallbackResponseExecutionReceiptLink {
        link_id: CodexAppServerCallbackResponseExecutionReceiptLinkId(format!(
            "codex-callback-response-execution-receipt-link:{}:{}",
            admission.request_id, outcome.outcome_id.0
        )),
        admission_id: admission.admission_id.0.clone(),
        policy_id: admission.policy_id.clone(),
        request_id: admission.request_id.clone(),
        callback_response_id: admission.callback_response_id.clone(),
        envelope_id: admission.envelope_id.clone(),
        provider_callback_id: admission.provider_callback_id.clone(),
        task_id: admission.task_id.clone(),
        work_item_id: admission.work_item_id.clone(),
        live_executor_outcome_id: outcome.outcome_id.0.clone(),
        runtime_receipt_id,
        provider_instance_id: outcome.provider_instance_id.clone(),
        callback_response_write_attempt_id: outcome.write_attempt_id.clone(),
        runtime_progress,
        status,
        callback_refs,
        evidence_refs,
        provider_completion_recorded: matches!(
            outcome.status,
            CodexAppServerLiveExecutorOutcomeStatus::Completed
        ),
        provider_write_recorded: outcome.provider_write_executed,
        task_completion_permitted: false,
        review_acceptance_permitted: false,
        raw_callback_material_retained: false,
    }
}

fn receipt_link_blockers(
    admission: &CodexAppServerCallbackResponseExecutorAdmissionRecord,
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
    runtime_receipt_id: &EngineRuntimeReceiptRecordId,
) -> Vec<CodexAppServerCallbackResponseExecutionReceiptLinkBlocker> {
    let mut blockers = Vec::new();

    if admission.status
        != CodexAppServerCallbackResponseExecutorAdmissionStatus::AcceptedForExecutorHandoff
    {
        blockers
            .push(CodexAppServerCallbackResponseExecutionReceiptLinkBlocker::AdmissionNotAccepted);
    }
    if outcome.outcome_id.0.is_empty() {
        blockers.push(CodexAppServerCallbackResponseExecutionReceiptLinkBlocker::MissingOutcomeId);
    }
    if runtime_receipt_id.0.is_empty() {
        blockers.push(
            CodexAppServerCallbackResponseExecutionReceiptLinkBlocker::MissingRuntimeReceiptId,
        );
    }
    if outcome.provider_instance_id.is_empty() {
        blockers.push(
            CodexAppServerCallbackResponseExecutionReceiptLinkBlocker::MissingProviderInstanceId,
        );
    }
    if outcome.write_attempt_id.is_empty() {
        blockers
            .push(CodexAppServerCallbackResponseExecutionReceiptLinkBlocker::MissingWriteAttemptId);
    }
    if outcome.provider_instance_id != admission.provider_instance_id {
        blockers.push(
            CodexAppServerCallbackResponseExecutionReceiptLinkBlocker::ProviderInstanceMismatch,
        );
    }
    if outcome.write_attempt_id != admission.callback_response_write_attempt_id.0 {
        blockers
            .push(CodexAppServerCallbackResponseExecutionReceiptLinkBlocker::WriteAttemptMismatch);
    }
    if outcome.raw_payload_retained {
        blockers.push(
            CodexAppServerCallbackResponseExecutionReceiptLinkBlocker::OutcomeRetainedRawPayload,
        );
    }
    if outcome.raw_stream_retained {
        blockers.push(
            CodexAppServerCallbackResponseExecutionReceiptLinkBlocker::OutcomeRetainedRawStream,
        );
    }
    if outcome.task_mutation_permitted {
        blockers.push(
            CodexAppServerCallbackResponseExecutionReceiptLinkBlocker::OutcomePermitsTaskMutation,
        );
    }
    if admission.raw_callback_material_retained {
        blockers.push(
            CodexAppServerCallbackResponseExecutionReceiptLinkBlocker::AdmissionRetainedRawCallbackMaterial,
        );
    }
    if admission.task_mutation_permitted {
        blockers.push(
            CodexAppServerCallbackResponseExecutionReceiptLinkBlocker::AdmissionPermitsTaskMutation,
        );
    }
    if admission.review_acceptance_permitted {
        blockers.push(
            CodexAppServerCallbackResponseExecutionReceiptLinkBlocker::AdmissionPermitsReviewAcceptance,
        );
    }

    blockers
}

fn runtime_progress_from_outcome(
    status: &CodexAppServerLiveExecutorOutcomeStatus,
) -> CodexAppServerCallbackResponseExecutionRuntimeProgress {
    match status {
        CodexAppServerLiveExecutorOutcomeStatus::Accepted => {
            CodexAppServerCallbackResponseExecutionRuntimeProgress::Accepted
        }
        CodexAppServerLiveExecutorOutcomeStatus::Completed => {
            CodexAppServerCallbackResponseExecutionRuntimeProgress::Completed
        }
        CodexAppServerLiveExecutorOutcomeStatus::Failed(reason) => {
            CodexAppServerCallbackResponseExecutionRuntimeProgress::Failed(reason.clone())
        }
        CodexAppServerLiveExecutorOutcomeStatus::TimedOut => {
            CodexAppServerCallbackResponseExecutionRuntimeProgress::TimedOut
        }
        CodexAppServerLiveExecutorOutcomeStatus::Blocked(reason) => {
            CodexAppServerCallbackResponseExecutionRuntimeProgress::Blocked(reason.clone())
        }
        CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(reason) => {
            CodexAppServerCallbackResponseExecutionRuntimeProgress::CleanupRequired(reason.clone())
        }
    }
}

fn callback_refs(
    admission: &CodexAppServerCallbackResponseExecutorAdmissionRecord,
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
    runtime_receipt_id: &EngineRuntimeReceiptRecordId,
) -> Vec<String> {
    vec![
        format!("request:{}", admission.request_id),
        format!("callback-response:{}", admission.callback_response_id),
        format!("envelope:{}", admission.envelope_id),
        format!("provider-callback:{}", admission.provider_callback_id),
        format!("task:{}", admission.task_id),
        format!("work-item:{}", admission.work_item_id),
        format!("write-attempt:{}", outcome.write_attempt_id),
        format!("receipt:{}", runtime_receipt_id.0),
        format!("codex-live-executor-outcome:{}", outcome.outcome_id.0),
    ]
}

fn evidence_refs(
    admission: &CodexAppServerCallbackResponseExecutorAdmissionRecord,
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
) -> Vec<String> {
    let mut refs = admission.evidence_refs.clone();
    refs.extend(outcome.evidence_refs.iter().cloned());
    refs.extend(outcome.receipt_refs.iter().cloned());
    refs.sort();
    refs.dedup();
    refs
}

#[cfg(test)]
mod tests;
