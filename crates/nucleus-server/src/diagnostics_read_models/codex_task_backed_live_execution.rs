use serde::{Deserialize, Serialize};

use crate::{
    CodexAppServerTaskWorkLiveExecutorAdmissionRecord,
    CodexAppServerTaskWorkLiveExecutorAdmissionStatus,
    CodexAppServerTaskWorkLiveExecutorReceiptLink,
    CodexAppServerTaskWorkLiveExecutorReceiptLinkStatus,
    CodexAppServerTaskWorkLiveExecutorRuntimeProgress,
};

use super::helpers::{source_status, source_summary};

/// Client-safe diagnostics for task-backed Codex live execution state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CodexTaskBackedLiveExecutionDiagnosticsDto {
    pub attempts: Vec<CodexTaskBackedLiveExecutionAttemptDiagnosticDto>,
    pub client_can_execute_provider_write: bool,
    pub client_can_mutate_tasks: bool,
    pub client_can_accept_review: bool,
    pub client_can_answer_callbacks: bool,
    pub client_can_cancel_provider: bool,
    pub client_can_resume_provider: bool,
    pub client_can_mutate_scm: bool,
    pub provider_material_exposed: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

/// One task-backed live execution attempt visible to diagnostics clients.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CodexTaskBackedLiveExecutionAttemptDiagnosticDto {
    pub work_item_id: String,
    pub task_id: String,
    pub project_id: String,
    pub admission_id: Option<String>,
    pub policy_id: Option<String>,
    pub live_executor_outcome_id: Option<String>,
    pub runtime_receipt_id: Option<String>,
    pub provider_instance_id: String,
    pub write_attempt_id: Option<String>,
    pub status: String,
    pub blockers: Vec<String>,
    pub runtime_progress: Option<String>,
    pub task_work_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub provider_completion_recorded: bool,
    pub provider_write_executed: bool,
    pub task_completion_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub callback_response_permitted: bool,
    pub cancellation_permitted: bool,
    pub resume_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub raw_provider_material_retained: bool,
    pub next_action: String,
}

pub fn codex_task_backed_live_execution_diagnostics(
    admissions: &[CodexAppServerTaskWorkLiveExecutorAdmissionRecord],
    links: &[CodexAppServerTaskWorkLiveExecutorReceiptLink],
) -> CodexTaskBackedLiveExecutionDiagnosticsDto {
    let mut attempts = admissions
        .iter()
        .map(CodexTaskBackedLiveExecutionAttemptDiagnosticDto::from)
        .collect::<Vec<_>>();
    attempts.extend(
        links
            .iter()
            .map(CodexTaskBackedLiveExecutionAttemptDiagnosticDto::from),
    );

    CodexTaskBackedLiveExecutionDiagnosticsDto {
        source_status: source_status(attempts.len()),
        source_summary: Some(source_summary(
            attempts.len(),
            "Task-backed Codex live execution diagnostics have no records yet",
            "Task-backed Codex live execution diagnostics loaded from sanitized refs",
        )),
        attempts,
        client_can_execute_provider_write: false,
        client_can_mutate_tasks: false,
        client_can_accept_review: false,
        client_can_answer_callbacks: false,
        client_can_cancel_provider: false,
        client_can_resume_provider: false,
        client_can_mutate_scm: false,
        provider_material_exposed: false,
    }
}

impl From<&CodexAppServerTaskWorkLiveExecutorAdmissionRecord>
    for CodexTaskBackedLiveExecutionAttemptDiagnosticDto
{
    fn from(record: &CodexAppServerTaskWorkLiveExecutorAdmissionRecord) -> Self {
        let blocked = admission_blockers(record);
        Self {
            work_item_id: record.work_item_id.0.clone(),
            task_id: record.task_id.0.clone(),
            project_id: record.project_id.0.clone(),
            admission_id: Some(record.admission_id.0.clone()),
            policy_id: Some(record.policy_id.clone()),
            live_executor_outcome_id: None,
            runtime_receipt_id: None,
            provider_instance_id: record.provider_instance_id.clone(),
            write_attempt_id: Some(record.live_executor_write_attempt_id.0.clone()),
            status: admission_status(&record.status),
            blockers: blocked,
            runtime_progress: None,
            task_work_refs: vec![
                format!("work-item:{}", record.work_item_id.0),
                format!("task:{}", record.task_id.0),
                format!("project:{}", record.project_id.0),
                format!("write-attempt:{}", record.live_executor_write_attempt_id.0),
                format!("idempotency:{}", record.idempotency_key.0),
            ],
            evidence_refs: record.evidence_refs.clone(),
            provider_completion_recorded: false,
            provider_write_executed: record.provider_write_executed,
            task_completion_permitted: false,
            review_acceptance_permitted: record.review_acceptance_permitted,
            callback_response_permitted: false,
            cancellation_permitted: false,
            resume_permitted: false,
            scm_mutation_permitted: false,
            raw_provider_material_retained: record.raw_provider_material_retained,
            next_action: admission_next_action(&record.status),
        }
    }
}

impl From<&CodexAppServerTaskWorkLiveExecutorReceiptLink>
    for CodexTaskBackedLiveExecutionAttemptDiagnosticDto
{
    fn from(link: &CodexAppServerTaskWorkLiveExecutorReceiptLink) -> Self {
        Self {
            work_item_id: link.work_item_id.0.clone(),
            task_id: link.task_id.0.clone(),
            project_id: link.project_id.0.clone(),
            admission_id: Some(link.admission_id.clone()),
            policy_id: None,
            live_executor_outcome_id: Some(link.live_executor_outcome_id.clone()),
            runtime_receipt_id: Some(link.runtime_receipt_id.0.clone()),
            provider_instance_id: link.provider_instance_id.clone(),
            write_attempt_id: Some(link.write_attempt_id.clone()),
            status: link_status(&link.status, &link.runtime_progress),
            blockers: link_blockers(link),
            runtime_progress: Some(runtime_progress_label(&link.runtime_progress)),
            task_work_refs: task_work_refs(link),
            evidence_refs: link.evidence_refs.clone(),
            provider_completion_recorded: link.provider_completion_recorded,
            provider_write_executed: link.provider_completion_recorded,
            task_completion_permitted: link.task_completion_permitted,
            review_acceptance_permitted: link.review_acceptance_permitted,
            callback_response_permitted: false,
            cancellation_permitted: false,
            resume_permitted: false,
            scm_mutation_permitted: false,
            raw_provider_material_retained: link.raw_provider_material_retained,
            next_action: link_next_action(&link.status, &link.runtime_progress),
        }
    }
}

fn admission_status(status: &CodexAppServerTaskWorkLiveExecutorAdmissionStatus) -> String {
    match status {
        CodexAppServerTaskWorkLiveExecutorAdmissionStatus::AcceptedForExecutorHandoff => "admitted",
        CodexAppServerTaskWorkLiveExecutorAdmissionStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn admission_blockers(record: &CodexAppServerTaskWorkLiveExecutorAdmissionRecord) -> Vec<String> {
    record
        .blockers
        .iter()
        .map(|blocker| format!("{blocker:?}"))
        .collect()
}

fn admission_next_action(status: &CodexAppServerTaskWorkLiveExecutorAdmissionStatus) -> String {
    match status {
        CodexAppServerTaskWorkLiveExecutorAdmissionStatus::AcceptedForExecutorHandoff => {
            "wait_for_live_executor_outcome"
        }
        CodexAppServerTaskWorkLiveExecutorAdmissionStatus::Blocked => "repair_admission_identity",
    }
    .to_owned()
}

fn link_status(
    status: &CodexAppServerTaskWorkLiveExecutorReceiptLinkStatus,
    progress: &CodexAppServerTaskWorkLiveExecutorRuntimeProgress,
) -> String {
    match status {
        CodexAppServerTaskWorkLiveExecutorReceiptLinkStatus::Blocked(_) => "blocked".to_owned(),
        CodexAppServerTaskWorkLiveExecutorReceiptLinkStatus::Linked => {
            runtime_progress_label(progress)
        }
    }
}

fn link_blockers(link: &CodexAppServerTaskWorkLiveExecutorReceiptLink) -> Vec<String> {
    match &link.status {
        CodexAppServerTaskWorkLiveExecutorReceiptLinkStatus::Linked => Vec::new(),
        CodexAppServerTaskWorkLiveExecutorReceiptLinkStatus::Blocked(blockers) => blockers
            .iter()
            .map(|blocker| format!("{blocker:?}"))
            .collect(),
    }
}

fn runtime_progress_label(progress: &CodexAppServerTaskWorkLiveExecutorRuntimeProgress) -> String {
    match progress {
        CodexAppServerTaskWorkLiveExecutorRuntimeProgress::Accepted => "accepted",
        CodexAppServerTaskWorkLiveExecutorRuntimeProgress::Completed => "completed",
        CodexAppServerTaskWorkLiveExecutorRuntimeProgress::Failed(_) => "failed",
        CodexAppServerTaskWorkLiveExecutorRuntimeProgress::TimedOut => "timed_out",
        CodexAppServerTaskWorkLiveExecutorRuntimeProgress::Blocked(_) => "blocked",
        CodexAppServerTaskWorkLiveExecutorRuntimeProgress::CleanupRequired(_) => "cleanup_required",
    }
    .to_owned()
}

fn task_work_refs(link: &CodexAppServerTaskWorkLiveExecutorReceiptLink) -> Vec<String> {
    let mut refs = Vec::new();
    refs.extend(
        link.refs
            .receipt_ids
            .iter()
            .map(|receipt_id| format!("receipt:{}", receipt_id.0)),
    );
    refs.extend(
        link.refs
            .artifact_refs
            .iter()
            .map(|artifact_ref| format!("artifact:{artifact_ref}")),
    );
    refs
}

fn link_next_action(
    status: &CodexAppServerTaskWorkLiveExecutorReceiptLinkStatus,
    progress: &CodexAppServerTaskWorkLiveExecutorRuntimeProgress,
) -> String {
    if matches!(
        status,
        CodexAppServerTaskWorkLiveExecutorReceiptLinkStatus::Blocked(_)
    ) {
        return "repair_receipt_linkage".to_owned();
    }

    match progress {
        CodexAppServerTaskWorkLiveExecutorRuntimeProgress::Accepted => "watch_for_completion",
        CodexAppServerTaskWorkLiveExecutorRuntimeProgress::Completed => {
            "inspect_receipt_without_accepting_review"
        }
        CodexAppServerTaskWorkLiveExecutorRuntimeProgress::Failed(_) => "inspect_failure_evidence",
        CodexAppServerTaskWorkLiveExecutorRuntimeProgress::TimedOut => "review_timeout_and_cleanup",
        CodexAppServerTaskWorkLiveExecutorRuntimeProgress::Blocked(_) => "repair_executor_gate",
        CodexAppServerTaskWorkLiveExecutorRuntimeProgress::CleanupRequired(_) => {
            "run_cleanup_or_repair_host"
        }
    }
    .to_owned()
}
