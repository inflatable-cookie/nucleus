//! Recovery execution receipt linkage records.
//!
//! These records link admitted recovery writes to sanitized executor outcomes
//! and runtime receipts. They record provider progress without promoting
//! replacement threads, accepting review, completing tasks, retaining raw
//! provider material, answering callbacks, interrupting turns, or mutating SCM
//! state.

use super::{
    CodexAppServerLiveExecutorOutcomeRecord, CodexAppServerLiveExecutorOutcomeStatus,
    CodexAppServerRecoveryExecutorAdmissionRecord, CodexAppServerRecoveryExecutorAdmissionStatus,
};

use nucleus_engine::EngineRuntimeReceiptRecordId;

/// Stable id for one recovery execution receipt linkage record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerRecoveryExecutionReceiptLinkId(pub String);

/// Link status for a recovery execution attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerRecoveryExecutionReceiptLinkStatus {
    Linked,
    Blocked(Vec<CodexAppServerRecoveryExecutionReceiptLinkBlocker>),
}

/// Runtime progress derived from a recovery executor outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerRecoveryExecutionRuntimeProgress {
    Accepted,
    Completed,
    Failed(String),
    TimedOut,
    Blocked(String),
    CleanupRequired(String),
    ReplacementThreadObserved(String),
}

/// Why recovery execution receipt linkage cannot be trusted.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerRecoveryExecutionReceiptLinkBlocker {
    AdmissionNotAccepted,
    MissingOutcomeId,
    MissingRuntimeReceiptId,
    MissingProviderInstanceId,
    MissingWriteAttemptId,
    ProviderInstanceMismatch,
    WriteAttemptMismatch,
    ReplacementThreadMismatch,
    OutcomeRetainedRawPayload,
    OutcomeRetainedRawStream,
    OutcomePermitsTaskMutation,
    OutcomePermitsCallbackResponse,
    OutcomePermitsCancellation,
    OutcomePermitsResume,
    AdmissionRetainedRawProviderMaterial,
    AdmissionRetainedRawCallbackMaterial,
    AdmissionPermitsTaskMutation,
    AdmissionPermitsReviewAcceptance,
    AdmissionPermitsReplacementThreadPromotion,
    AdmissionPermitsInterruption,
    AdmissionPermitsCallbackAnswer,
    AdmissionPermitsScmMutation,
}

/// Reference-only linkage from recovery execution to a runtime receipt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerRecoveryExecutionReceiptLink {
    pub link_id: CodexAppServerRecoveryExecutionReceiptLinkId,
    pub admission_id: String,
    pub policy_id: String,
    pub need_id: String,
    pub envelope_id: String,
    pub provider_thread_id: String,
    pub provider_turn_id: Option<String>,
    pub provider_request_id: Option<String>,
    pub task_id: String,
    pub work_item_id: String,
    pub live_executor_outcome_id: String,
    pub runtime_receipt_id: EngineRuntimeReceiptRecordId,
    pub provider_instance_id: String,
    pub recovery_write_attempt_id: String,
    pub runtime_progress: CodexAppServerRecoveryExecutionRuntimeProgress,
    pub status: CodexAppServerRecoveryExecutionReceiptLinkStatus,
    pub recovery_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub provider_completion_recorded: bool,
    pub provider_write_recorded: bool,
    pub replacement_thread_observed: bool,
    pub task_completion_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub replacement_thread_promotion_permitted: bool,
    pub interruption_permitted: bool,
    pub callback_answer_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub raw_provider_material_retained: bool,
    pub raw_callback_material_retained: bool,
}

/// Build reference-only recovery execution receipt linkage.
pub fn codex_recovery_execution_receipt_link(
    admission: &CodexAppServerRecoveryExecutorAdmissionRecord,
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
    runtime_receipt_id: EngineRuntimeReceiptRecordId,
) -> CodexAppServerRecoveryExecutionReceiptLink {
    let blockers = receipt_link_blockers(admission, outcome, &runtime_receipt_id);
    let status = if blockers.is_empty() {
        CodexAppServerRecoveryExecutionReceiptLinkStatus::Linked
    } else {
        CodexAppServerRecoveryExecutionReceiptLinkStatus::Blocked(blockers)
    };
    let runtime_progress = runtime_progress_from_outcome(admission, outcome);
    let recovery_refs = recovery_refs(admission, outcome, &runtime_receipt_id);
    let evidence_refs = evidence_refs(admission, outcome);

    CodexAppServerRecoveryExecutionReceiptLink {
        link_id: CodexAppServerRecoveryExecutionReceiptLinkId(format!(
            "codex-recovery-execution-receipt-link:{}:{}",
            admission.need_id, outcome.outcome_id.0
        )),
        admission_id: admission.admission_id.0.clone(),
        policy_id: admission.policy_id.clone(),
        need_id: admission.need_id.clone(),
        envelope_id: admission.envelope_id.clone(),
        provider_thread_id: admission.provider_thread_id.clone(),
        provider_turn_id: admission.provider_turn_id.clone(),
        provider_request_id: admission.provider_request_id.clone(),
        task_id: admission.task_id.clone(),
        work_item_id: admission.work_item_id.clone(),
        live_executor_outcome_id: outcome.outcome_id.0.clone(),
        runtime_receipt_id,
        provider_instance_id: outcome.provider_instance_id.clone(),
        recovery_write_attempt_id: outcome.write_attempt_id.clone(),
        runtime_progress,
        status,
        recovery_refs,
        evidence_refs,
        provider_completion_recorded: matches!(
            outcome.status,
            CodexAppServerLiveExecutorOutcomeStatus::Completed
        ),
        provider_write_recorded: outcome.provider_write_executed,
        replacement_thread_observed: replacement_thread_observed(admission, outcome),
        task_completion_permitted: false,
        review_acceptance_permitted: false,
        replacement_thread_promotion_permitted: false,
        interruption_permitted: false,
        callback_answer_permitted: false,
        scm_mutation_permitted: false,
        raw_provider_material_retained: false,
        raw_callback_material_retained: false,
    }
}

fn receipt_link_blockers(
    admission: &CodexAppServerRecoveryExecutorAdmissionRecord,
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
    runtime_receipt_id: &EngineRuntimeReceiptRecordId,
) -> Vec<CodexAppServerRecoveryExecutionReceiptLinkBlocker> {
    let mut blockers = Vec::new();

    if admission.status != CodexAppServerRecoveryExecutorAdmissionStatus::AcceptedForExecutorHandoff
    {
        blockers.push(CodexAppServerRecoveryExecutionReceiptLinkBlocker::AdmissionNotAccepted);
    }
    if outcome.outcome_id.0.is_empty() {
        blockers.push(CodexAppServerRecoveryExecutionReceiptLinkBlocker::MissingOutcomeId);
    }
    if runtime_receipt_id.0.is_empty() {
        blockers.push(CodexAppServerRecoveryExecutionReceiptLinkBlocker::MissingRuntimeReceiptId);
    }
    if outcome.provider_instance_id.is_empty() {
        blockers.push(CodexAppServerRecoveryExecutionReceiptLinkBlocker::MissingProviderInstanceId);
    }
    if outcome.write_attempt_id.is_empty() {
        blockers.push(CodexAppServerRecoveryExecutionReceiptLinkBlocker::MissingWriteAttemptId);
    }
    if outcome.provider_instance_id != admission.provider_instance_id {
        blockers.push(CodexAppServerRecoveryExecutionReceiptLinkBlocker::ProviderInstanceMismatch);
    }
    if outcome.write_attempt_id != admission.recovery_write_attempt_id.0 {
        blockers.push(CodexAppServerRecoveryExecutionReceiptLinkBlocker::WriteAttemptMismatch);
    }
    if replacement_thread_observed(admission, outcome) {
        blockers.push(CodexAppServerRecoveryExecutionReceiptLinkBlocker::ReplacementThreadMismatch);
    }
    if outcome.raw_payload_retained {
        blockers.push(CodexAppServerRecoveryExecutionReceiptLinkBlocker::OutcomeRetainedRawPayload);
    }
    if outcome.raw_stream_retained {
        blockers.push(CodexAppServerRecoveryExecutionReceiptLinkBlocker::OutcomeRetainedRawStream);
    }
    if outcome.task_mutation_permitted {
        blockers
            .push(CodexAppServerRecoveryExecutionReceiptLinkBlocker::OutcomePermitsTaskMutation);
    }
    if outcome.callback_response_permitted {
        blockers.push(
            CodexAppServerRecoveryExecutionReceiptLinkBlocker::OutcomePermitsCallbackResponse,
        );
    }
    if outcome.cancellation_permitted {
        blockers
            .push(CodexAppServerRecoveryExecutionReceiptLinkBlocker::OutcomePermitsCancellation);
    }
    if outcome.resume_permitted {
        blockers.push(CodexAppServerRecoveryExecutionReceiptLinkBlocker::OutcomePermitsResume);
    }
    if admission.raw_provider_material_retained {
        blockers.push(
            CodexAppServerRecoveryExecutionReceiptLinkBlocker::AdmissionRetainedRawProviderMaterial,
        );
    }
    if admission.raw_callback_material_retained {
        blockers.push(
            CodexAppServerRecoveryExecutionReceiptLinkBlocker::AdmissionRetainedRawCallbackMaterial,
        );
    }
    if admission.task_mutation_permitted {
        blockers
            .push(CodexAppServerRecoveryExecutionReceiptLinkBlocker::AdmissionPermitsTaskMutation);
    }
    if admission.review_acceptance_permitted {
        blockers.push(
            CodexAppServerRecoveryExecutionReceiptLinkBlocker::AdmissionPermitsReviewAcceptance,
        );
    }
    if admission.replacement_thread_promotion_permitted {
        blockers.push(
            CodexAppServerRecoveryExecutionReceiptLinkBlocker::AdmissionPermitsReplacementThreadPromotion,
        );
    }
    if admission.interruption_permitted {
        blockers
            .push(CodexAppServerRecoveryExecutionReceiptLinkBlocker::AdmissionPermitsInterruption);
    }
    if admission.callback_answer_permitted {
        blockers.push(
            CodexAppServerRecoveryExecutionReceiptLinkBlocker::AdmissionPermitsCallbackAnswer,
        );
    }
    if admission.scm_mutation_permitted {
        blockers
            .push(CodexAppServerRecoveryExecutionReceiptLinkBlocker::AdmissionPermitsScmMutation);
    }

    blockers
}

fn runtime_progress_from_outcome(
    admission: &CodexAppServerRecoveryExecutorAdmissionRecord,
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
) -> CodexAppServerRecoveryExecutionRuntimeProgress {
    match &outcome.status {
        CodexAppServerLiveExecutorOutcomeStatus::Accepted => {
            CodexAppServerRecoveryExecutionRuntimeProgress::Accepted
        }
        CodexAppServerLiveExecutorOutcomeStatus::Completed
            if replacement_thread_observed(admission, outcome) =>
        {
            CodexAppServerRecoveryExecutionRuntimeProgress::ReplacementThreadObserved(
                "replacement thread observed during recovery".to_owned(),
            )
        }
        CodexAppServerLiveExecutorOutcomeStatus::Completed => {
            CodexAppServerRecoveryExecutionRuntimeProgress::Completed
        }
        CodexAppServerLiveExecutorOutcomeStatus::Failed(reason) => {
            CodexAppServerRecoveryExecutionRuntimeProgress::Failed(reason.clone())
        }
        CodexAppServerLiveExecutorOutcomeStatus::TimedOut => {
            CodexAppServerRecoveryExecutionRuntimeProgress::TimedOut
        }
        CodexAppServerLiveExecutorOutcomeStatus::Blocked(reason) => {
            CodexAppServerRecoveryExecutionRuntimeProgress::Blocked(reason.clone())
        }
        CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(reason) => {
            CodexAppServerRecoveryExecutionRuntimeProgress::CleanupRequired(reason.clone())
        }
    }
}

fn replacement_thread_observed(
    admission: &CodexAppServerRecoveryExecutorAdmissionRecord,
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
) -> bool {
    matches!(
        outcome.status,
        CodexAppServerLiveExecutorOutcomeStatus::Completed
    ) && outcome
        .thread_id
        .as_deref()
        .is_some_and(|thread_id| !thread_id.is_empty() && thread_id != admission.provider_thread_id)
}

fn recovery_refs(
    admission: &CodexAppServerRecoveryExecutorAdmissionRecord,
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
    runtime_receipt_id: &EngineRuntimeReceiptRecordId,
) -> Vec<String> {
    let mut refs = vec![
        format!("need:{}", admission.need_id),
        format!("envelope:{}", admission.envelope_id),
        format!("provider-thread:{}", admission.provider_thread_id),
        format!("task:{}", admission.task_id),
        format!("work-item:{}", admission.work_item_id),
        format!("write-attempt:{}", outcome.write_attempt_id),
        format!("receipt:{}", runtime_receipt_id.0),
        format!("codex-live-executor-outcome:{}", outcome.outcome_id.0),
    ];
    if let Some(provider_turn_id) = &admission.provider_turn_id {
        refs.push(format!("provider-turn:{provider_turn_id}"));
    }
    if let Some(provider_request_id) = &admission.provider_request_id {
        refs.push(format!("provider-request:{provider_request_id}"));
    }
    refs
}

fn evidence_refs(
    admission: &CodexAppServerRecoveryExecutorAdmissionRecord,
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
