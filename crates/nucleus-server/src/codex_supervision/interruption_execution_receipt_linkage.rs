//! Interruption execution receipt linkage records.
//!
//! These records link admitted interruption writes to sanitized executor
//! outcomes and runtime receipts. They record provider progress without
//! accepting review, completing tasks, retaining raw provider material,
//! recovering sessions, answering callbacks, or mutating SCM state.

use super::{
    CodexAppServerInterruptionExecutorAdmissionRecord,
    CodexAppServerInterruptionExecutorAdmissionStatus, CodexAppServerLiveExecutorOutcomeRecord,
    CodexAppServerLiveExecutorOutcomeStatus,
};

use nucleus_engine::EngineRuntimeReceiptRecordId;

/// Stable id for one interruption execution receipt linkage record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerInterruptionExecutionReceiptLinkId(pub String);

/// Link status for an interruption execution attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerInterruptionExecutionReceiptLinkStatus {
    Linked,
    Blocked(Vec<CodexAppServerInterruptionExecutionReceiptLinkBlocker>),
}

/// Runtime progress derived from an interruption executor outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerInterruptionExecutionRuntimeProgress {
    Accepted,
    Completed,
    Failed(String),
    TimedOut,
    Blocked(String),
    CleanupRequired(String),
}

/// Why interruption execution receipt linkage cannot be trusted.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerInterruptionExecutionReceiptLinkBlocker {
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
    AdmissionRetainedRawProviderMaterial,
    AdmissionRetainedRawCallbackMaterial,
    AdmissionPermitsTaskMutation,
    AdmissionPermitsReviewAcceptance,
    AdmissionPermitsResume,
    AdmissionPermitsCallbackAnswer,
    AdmissionPermitsScmMutation,
}

/// Reference-only linkage from interruption execution to a runtime receipt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerInterruptionExecutionReceiptLink {
    pub link_id: CodexAppServerInterruptionExecutionReceiptLinkId,
    pub admission_id: String,
    pub policy_id: String,
    pub request_id: String,
    pub envelope_id: String,
    pub provider_turn_id: String,
    pub provider_request_id: Option<String>,
    pub task_id: String,
    pub work_item_id: String,
    pub live_executor_outcome_id: String,
    pub runtime_receipt_id: EngineRuntimeReceiptRecordId,
    pub provider_instance_id: String,
    pub interruption_write_attempt_id: String,
    pub runtime_progress: CodexAppServerInterruptionExecutionRuntimeProgress,
    pub status: CodexAppServerInterruptionExecutionReceiptLinkStatus,
    pub interruption_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub provider_completion_recorded: bool,
    pub provider_write_recorded: bool,
    pub task_completion_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub resume_permitted: bool,
    pub callback_answer_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub raw_provider_material_retained: bool,
    pub raw_callback_material_retained: bool,
}

/// Build reference-only interruption execution receipt linkage.
pub fn codex_interruption_execution_receipt_link(
    admission: &CodexAppServerInterruptionExecutorAdmissionRecord,
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
    runtime_receipt_id: EngineRuntimeReceiptRecordId,
) -> CodexAppServerInterruptionExecutionReceiptLink {
    let blockers = receipt_link_blockers(admission, outcome, &runtime_receipt_id);
    let status = if blockers.is_empty() {
        CodexAppServerInterruptionExecutionReceiptLinkStatus::Linked
    } else {
        CodexAppServerInterruptionExecutionReceiptLinkStatus::Blocked(blockers)
    };
    let runtime_progress = runtime_progress_from_outcome(&outcome.status);
    let interruption_refs = interruption_refs(admission, outcome, &runtime_receipt_id);
    let evidence_refs = evidence_refs(admission, outcome);

    CodexAppServerInterruptionExecutionReceiptLink {
        link_id: CodexAppServerInterruptionExecutionReceiptLinkId(format!(
            "codex-interruption-execution-receipt-link:{}:{}",
            admission.request_id, outcome.outcome_id.0
        )),
        admission_id: admission.admission_id.0.clone(),
        policy_id: admission.policy_id.clone(),
        request_id: admission.request_id.clone(),
        envelope_id: admission.envelope_id.clone(),
        provider_turn_id: admission.provider_turn_id.clone(),
        provider_request_id: admission.provider_request_id.clone(),
        task_id: admission.task_id.clone(),
        work_item_id: admission.work_item_id.clone(),
        live_executor_outcome_id: outcome.outcome_id.0.clone(),
        runtime_receipt_id,
        provider_instance_id: outcome.provider_instance_id.clone(),
        interruption_write_attempt_id: outcome.write_attempt_id.clone(),
        runtime_progress,
        status,
        interruption_refs,
        evidence_refs,
        provider_completion_recorded: matches!(
            outcome.status,
            CodexAppServerLiveExecutorOutcomeStatus::Completed
        ),
        provider_write_recorded: outcome.provider_write_executed,
        task_completion_permitted: false,
        review_acceptance_permitted: false,
        resume_permitted: false,
        callback_answer_permitted: false,
        scm_mutation_permitted: false,
        raw_provider_material_retained: false,
        raw_callback_material_retained: false,
    }
}

fn receipt_link_blockers(
    admission: &CodexAppServerInterruptionExecutorAdmissionRecord,
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
    runtime_receipt_id: &EngineRuntimeReceiptRecordId,
) -> Vec<CodexAppServerInterruptionExecutionReceiptLinkBlocker> {
    let mut blockers = Vec::new();

    if admission.status
        != CodexAppServerInterruptionExecutorAdmissionStatus::AcceptedForExecutorHandoff
    {
        blockers.push(CodexAppServerInterruptionExecutionReceiptLinkBlocker::AdmissionNotAccepted);
    }
    if outcome.outcome_id.0.is_empty() {
        blockers.push(CodexAppServerInterruptionExecutionReceiptLinkBlocker::MissingOutcomeId);
    }
    if runtime_receipt_id.0.is_empty() {
        blockers
            .push(CodexAppServerInterruptionExecutionReceiptLinkBlocker::MissingRuntimeReceiptId);
    }
    if outcome.provider_instance_id.is_empty() {
        blockers
            .push(CodexAppServerInterruptionExecutionReceiptLinkBlocker::MissingProviderInstanceId);
    }
    if outcome.write_attempt_id.is_empty() {
        blockers.push(CodexAppServerInterruptionExecutionReceiptLinkBlocker::MissingWriteAttemptId);
    }
    if outcome.provider_instance_id != admission.provider_instance_id {
        blockers
            .push(CodexAppServerInterruptionExecutionReceiptLinkBlocker::ProviderInstanceMismatch);
    }
    if outcome.write_attempt_id != admission.interruption_write_attempt_id.0 {
        blockers.push(CodexAppServerInterruptionExecutionReceiptLinkBlocker::WriteAttemptMismatch);
    }
    if outcome.raw_payload_retained {
        blockers
            .push(CodexAppServerInterruptionExecutionReceiptLinkBlocker::OutcomeRetainedRawPayload);
    }
    if outcome.raw_stream_retained {
        blockers
            .push(CodexAppServerInterruptionExecutionReceiptLinkBlocker::OutcomeRetainedRawStream);
    }
    if outcome.task_mutation_permitted {
        blockers.push(
            CodexAppServerInterruptionExecutionReceiptLinkBlocker::OutcomePermitsTaskMutation,
        );
    }
    if admission.raw_provider_material_retained {
        blockers.push(
            CodexAppServerInterruptionExecutionReceiptLinkBlocker::AdmissionRetainedRawProviderMaterial,
        );
    }
    if admission.raw_callback_material_retained {
        blockers.push(
            CodexAppServerInterruptionExecutionReceiptLinkBlocker::AdmissionRetainedRawCallbackMaterial,
        );
    }
    if admission.task_mutation_permitted {
        blockers.push(
            CodexAppServerInterruptionExecutionReceiptLinkBlocker::AdmissionPermitsTaskMutation,
        );
    }
    if admission.review_acceptance_permitted {
        blockers.push(
            CodexAppServerInterruptionExecutionReceiptLinkBlocker::AdmissionPermitsReviewAcceptance,
        );
    }
    if admission.resume_permitted {
        blockers
            .push(CodexAppServerInterruptionExecutionReceiptLinkBlocker::AdmissionPermitsResume);
    }
    if admission.callback_answer_permitted {
        blockers.push(
            CodexAppServerInterruptionExecutionReceiptLinkBlocker::AdmissionPermitsCallbackAnswer,
        );
    }
    if admission.scm_mutation_permitted {
        blockers.push(
            CodexAppServerInterruptionExecutionReceiptLinkBlocker::AdmissionPermitsScmMutation,
        );
    }

    blockers
}

fn runtime_progress_from_outcome(
    status: &CodexAppServerLiveExecutorOutcomeStatus,
) -> CodexAppServerInterruptionExecutionRuntimeProgress {
    match status {
        CodexAppServerLiveExecutorOutcomeStatus::Accepted => {
            CodexAppServerInterruptionExecutionRuntimeProgress::Accepted
        }
        CodexAppServerLiveExecutorOutcomeStatus::Completed => {
            CodexAppServerInterruptionExecutionRuntimeProgress::Completed
        }
        CodexAppServerLiveExecutorOutcomeStatus::Failed(reason) => {
            CodexAppServerInterruptionExecutionRuntimeProgress::Failed(reason.clone())
        }
        CodexAppServerLiveExecutorOutcomeStatus::TimedOut => {
            CodexAppServerInterruptionExecutionRuntimeProgress::TimedOut
        }
        CodexAppServerLiveExecutorOutcomeStatus::Blocked(reason) => {
            CodexAppServerInterruptionExecutionRuntimeProgress::Blocked(reason.clone())
        }
        CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(reason) => {
            CodexAppServerInterruptionExecutionRuntimeProgress::CleanupRequired(reason.clone())
        }
    }
}

fn interruption_refs(
    admission: &CodexAppServerInterruptionExecutorAdmissionRecord,
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
    runtime_receipt_id: &EngineRuntimeReceiptRecordId,
) -> Vec<String> {
    let mut refs = vec![
        format!("request:{}", admission.request_id),
        format!("envelope:{}", admission.envelope_id),
        format!("provider-turn:{}", admission.provider_turn_id),
        format!("task:{}", admission.task_id),
        format!("work-item:{}", admission.work_item_id),
        format!("write-attempt:{}", outcome.write_attempt_id),
        format!("receipt:{}", runtime_receipt_id.0),
        format!("codex-live-executor-outcome:{}", outcome.outcome_id.0),
    ];
    if let Some(provider_request_id) = &admission.provider_request_id {
        refs.push(format!("provider-request:{provider_request_id}"));
    }
    refs
}

fn evidence_refs(
    admission: &CodexAppServerInterruptionExecutorAdmissionRecord,
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
