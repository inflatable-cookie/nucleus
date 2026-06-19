//! Task work live executor receipt linkage records.
//!
//! These records link task work items to sanitized Codex live executor outcomes
//! and runtime receipts. They preserve runtime progress without completing
//! tasks, accepting review, retaining provider material, or mutating work item
//! state directly.

use super::{
    CodexAppServerLiveExecutorOutcomeRecord, CodexAppServerLiveExecutorOutcomeStatus,
    CodexAppServerTaskWorkLiveExecutorAdmissionRecord,
    CodexAppServerTaskWorkLiveExecutorAdmissionStatus,
};

use nucleus_engine::{EngineRuntimeReceiptRecordId, EngineTaskWorkItemId, EngineTaskWorkItemRefs};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

/// Stable id for a task work live executor receipt linkage record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerTaskWorkLiveExecutorReceiptLinkId(pub String);

/// Link status for a task work item and live executor outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTaskWorkLiveExecutorReceiptLinkStatus {
    Linked,
    Blocked(Vec<CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker>),
}

/// Runtime progress derived from a Codex live executor outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTaskWorkLiveExecutorRuntimeProgress {
    Accepted,
    Completed,
    Failed(String),
    TimedOut,
    Blocked(String),
    CleanupRequired(String),
}

/// Why task work receipt linkage cannot be trusted.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker {
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
    AdmissionPermitsTaskMutation,
    AdmissionPermitsReviewAcceptance,
}

/// Reference-only linkage from task work to a live executor outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTaskWorkLiveExecutorReceiptLink {
    pub link_id: CodexAppServerTaskWorkLiveExecutorReceiptLinkId,
    pub work_item_id: EngineTaskWorkItemId,
    pub task_id: TaskId,
    pub project_id: ProjectId,
    pub admission_id: String,
    pub live_executor_outcome_id: String,
    pub runtime_receipt_id: EngineRuntimeReceiptRecordId,
    pub provider_instance_id: String,
    pub write_attempt_id: String,
    pub runtime_progress: CodexAppServerTaskWorkLiveExecutorRuntimeProgress,
    pub status: CodexAppServerTaskWorkLiveExecutorReceiptLinkStatus,
    pub refs: EngineTaskWorkItemRefs,
    pub evidence_refs: Vec<String>,
    pub provider_completion_recorded: bool,
    pub task_completion_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub raw_provider_material_retained: bool,
}

/// Build reference-only task work linkage for a Codex live executor outcome.
pub fn codex_task_work_live_executor_receipt_link(
    admission: &CodexAppServerTaskWorkLiveExecutorAdmissionRecord,
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
    runtime_receipt_id: EngineRuntimeReceiptRecordId,
) -> CodexAppServerTaskWorkLiveExecutorReceiptLink {
    let blockers = receipt_link_blockers(admission, outcome, &runtime_receipt_id);
    let status = if blockers.is_empty() {
        CodexAppServerTaskWorkLiveExecutorReceiptLinkStatus::Linked
    } else {
        CodexAppServerTaskWorkLiveExecutorReceiptLinkStatus::Blocked(blockers)
    };
    let runtime_progress = runtime_progress_from_outcome(&outcome.status);
    let refs = task_work_refs(outcome, &runtime_receipt_id);
    let evidence_refs = evidence_refs(admission, outcome);

    CodexAppServerTaskWorkLiveExecutorReceiptLink {
        link_id: CodexAppServerTaskWorkLiveExecutorReceiptLinkId(format!(
            "codex-task-work-live-executor-receipt-link:{}:{}",
            admission.work_item_id.0, outcome.outcome_id.0
        )),
        work_item_id: admission.work_item_id.clone(),
        task_id: admission.task_id.clone(),
        project_id: admission.project_id.clone(),
        admission_id: admission.admission_id.0.clone(),
        live_executor_outcome_id: outcome.outcome_id.0.clone(),
        runtime_receipt_id,
        provider_instance_id: outcome.provider_instance_id.clone(),
        write_attempt_id: outcome.write_attempt_id.clone(),
        runtime_progress,
        status,
        refs,
        evidence_refs,
        provider_completion_recorded: matches!(
            outcome.status,
            CodexAppServerLiveExecutorOutcomeStatus::Completed
        ),
        task_completion_permitted: false,
        review_acceptance_permitted: false,
        raw_provider_material_retained: false,
    }
}

fn receipt_link_blockers(
    admission: &CodexAppServerTaskWorkLiveExecutorAdmissionRecord,
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
    runtime_receipt_id: &EngineRuntimeReceiptRecordId,
) -> Vec<CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker> {
    let mut blockers = Vec::new();

    if admission.status
        != CodexAppServerTaskWorkLiveExecutorAdmissionStatus::AcceptedForExecutorHandoff
    {
        blockers.push(CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::AdmissionNotAccepted);
    }
    if outcome.outcome_id.0.is_empty() {
        blockers.push(CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::MissingOutcomeId);
    }
    if runtime_receipt_id.0.is_empty() {
        blockers
            .push(CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::MissingRuntimeReceiptId);
    }
    if outcome.provider_instance_id.is_empty() {
        blockers
            .push(CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::MissingProviderInstanceId);
    }
    if outcome.write_attempt_id.is_empty() {
        blockers.push(CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::MissingWriteAttemptId);
    }
    if outcome.provider_instance_id != admission.provider_instance_id {
        blockers
            .push(CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::ProviderInstanceMismatch);
    }
    if outcome.write_attempt_id != admission.live_executor_write_attempt_id.0 {
        blockers.push(CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::WriteAttemptMismatch);
    }
    if outcome.raw_payload_retained {
        blockers
            .push(CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::OutcomeRetainedRawPayload);
    }
    if outcome.raw_stream_retained {
        blockers
            .push(CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::OutcomeRetainedRawStream);
    }
    if outcome.task_mutation_permitted {
        blockers
            .push(CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::OutcomePermitsTaskMutation);
    }
    if admission.task_mutation_permitted {
        blockers.push(
            CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::AdmissionPermitsTaskMutation,
        );
    }
    if admission.review_acceptance_permitted {
        blockers.push(
            CodexAppServerTaskWorkLiveExecutorReceiptLinkBlocker::AdmissionPermitsReviewAcceptance,
        );
    }

    blockers
}

fn runtime_progress_from_outcome(
    status: &CodexAppServerLiveExecutorOutcomeStatus,
) -> CodexAppServerTaskWorkLiveExecutorRuntimeProgress {
    match status {
        CodexAppServerLiveExecutorOutcomeStatus::Accepted => {
            CodexAppServerTaskWorkLiveExecutorRuntimeProgress::Accepted
        }
        CodexAppServerLiveExecutorOutcomeStatus::Completed => {
            CodexAppServerTaskWorkLiveExecutorRuntimeProgress::Completed
        }
        CodexAppServerLiveExecutorOutcomeStatus::Failed(reason) => {
            CodexAppServerTaskWorkLiveExecutorRuntimeProgress::Failed(reason.clone())
        }
        CodexAppServerLiveExecutorOutcomeStatus::TimedOut => {
            CodexAppServerTaskWorkLiveExecutorRuntimeProgress::TimedOut
        }
        CodexAppServerLiveExecutorOutcomeStatus::Blocked(reason) => {
            CodexAppServerTaskWorkLiveExecutorRuntimeProgress::Blocked(reason.clone())
        }
        CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(reason) => {
            CodexAppServerTaskWorkLiveExecutorRuntimeProgress::CleanupRequired(reason.clone())
        }
    }
}

fn task_work_refs(
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
    runtime_receipt_id: &EngineRuntimeReceiptRecordId,
) -> EngineTaskWorkItemRefs {
    EngineTaskWorkItemRefs {
        receipt_ids: vec![runtime_receipt_id.clone()],
        artifact_refs: vec![format!(
            "codex-live-executor-outcome:{}",
            outcome.outcome_id.0
        )],
        ..EngineTaskWorkItemRefs::default()
    }
}

fn evidence_refs(
    admission: &CodexAppServerTaskWorkLiveExecutorAdmissionRecord,
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
