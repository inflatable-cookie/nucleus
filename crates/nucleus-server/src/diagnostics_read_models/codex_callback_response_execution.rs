use serde::{Deserialize, Serialize};

use crate::{
    CodexAppServerCallbackResponseExecutionReceiptLink,
    CodexAppServerCallbackResponseExecutionReceiptLinkStatus,
    CodexAppServerCallbackResponseExecutionRuntimeProgress,
    CodexAppServerCallbackResponseExecutorAdmissionRecord,
    CodexAppServerCallbackResponseExecutorAdmissionStatus,
};

use super::helpers::{source_status, source_summary};

/// Client-safe diagnostics for Codex callback response execution state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CodexCallbackResponseExecutionDiagnosticsDto {
    pub attempts: Vec<CodexCallbackResponseExecutionAttemptDiagnosticDto>,
    pub client_can_execute_provider_write: bool,
    pub client_can_answer_callbacks: bool,
    pub client_can_mutate_tasks: bool,
    pub client_can_accept_review: bool,
    pub client_can_cancel_provider: bool,
    pub client_can_resume_provider: bool,
    pub client_can_mutate_scm: bool,
    pub provider_material_exposed: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

/// One callback response execution attempt visible to diagnostics clients.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CodexCallbackResponseExecutionAttemptDiagnosticDto {
    pub request_id: String,
    pub callback_response_id: String,
    pub envelope_id: String,
    pub provider_callback_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub admission_id: Option<String>,
    pub policy_id: Option<String>,
    pub live_executor_outcome_id: Option<String>,
    pub runtime_receipt_id: Option<String>,
    pub provider_instance_id: String,
    pub callback_response_write_attempt_id: Option<String>,
    pub status: String,
    pub blockers: Vec<String>,
    pub runtime_progress: Option<String>,
    pub callback_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub provider_completion_recorded: bool,
    pub provider_write_recorded: bool,
    pub task_completion_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub callback_answer_permitted: bool,
    pub cancellation_permitted: bool,
    pub resume_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub raw_callback_material_retained: bool,
    pub next_action: String,
}

pub fn codex_callback_response_execution_diagnostics(
    admissions: &[CodexAppServerCallbackResponseExecutorAdmissionRecord],
    links: &[CodexAppServerCallbackResponseExecutionReceiptLink],
) -> CodexCallbackResponseExecutionDiagnosticsDto {
    let mut attempts = admissions
        .iter()
        .map(CodexCallbackResponseExecutionAttemptDiagnosticDto::from)
        .collect::<Vec<_>>();
    attempts.extend(
        links
            .iter()
            .map(CodexCallbackResponseExecutionAttemptDiagnosticDto::from),
    );

    CodexCallbackResponseExecutionDiagnosticsDto {
        source_status: source_status(attempts.len()),
        source_summary: Some(source_summary(
            attempts.len(),
            "Codex callback response execution diagnostics have no records yet",
            "Codex callback response execution diagnostics loaded from sanitized refs",
        )),
        attempts,
        client_can_execute_provider_write: false,
        client_can_answer_callbacks: false,
        client_can_mutate_tasks: false,
        client_can_accept_review: false,
        client_can_cancel_provider: false,
        client_can_resume_provider: false,
        client_can_mutate_scm: false,
        provider_material_exposed: false,
    }
}

impl From<&CodexAppServerCallbackResponseExecutorAdmissionRecord>
    for CodexCallbackResponseExecutionAttemptDiagnosticDto
{
    fn from(record: &CodexAppServerCallbackResponseExecutorAdmissionRecord) -> Self {
        Self {
            request_id: record.request_id.clone(),
            callback_response_id: record.callback_response_id.clone(),
            envelope_id: record.envelope_id.clone(),
            provider_callback_id: record.provider_callback_id.clone(),
            task_id: record.task_id.clone(),
            work_item_id: record.work_item_id.clone(),
            admission_id: Some(record.admission_id.0.clone()),
            policy_id: Some(record.policy_id.clone()),
            live_executor_outcome_id: None,
            runtime_receipt_id: None,
            provider_instance_id: record.provider_instance_id.clone(),
            callback_response_write_attempt_id: Some(
                record.callback_response_write_attempt_id.0.clone(),
            ),
            status: admission_status(&record.status),
            blockers: record
                .blockers
                .iter()
                .map(|blocker| format!("{blocker:?}"))
                .collect(),
            runtime_progress: None,
            callback_refs: admission_refs(record),
            evidence_refs: record.evidence_refs.clone(),
            provider_completion_recorded: false,
            provider_write_recorded: record.provider_write_executed,
            task_completion_permitted: record.task_mutation_permitted,
            review_acceptance_permitted: record.review_acceptance_permitted,
            callback_answer_permitted: false,
            cancellation_permitted: false,
            resume_permitted: false,
            scm_mutation_permitted: false,
            raw_callback_material_retained: record.raw_callback_material_retained,
            next_action: admission_next_action(&record.status),
        }
    }
}

impl From<&CodexAppServerCallbackResponseExecutionReceiptLink>
    for CodexCallbackResponseExecutionAttemptDiagnosticDto
{
    fn from(link: &CodexAppServerCallbackResponseExecutionReceiptLink) -> Self {
        Self {
            request_id: link.request_id.clone(),
            callback_response_id: link.callback_response_id.clone(),
            envelope_id: link.envelope_id.clone(),
            provider_callback_id: link.provider_callback_id.clone(),
            task_id: link.task_id.clone(),
            work_item_id: link.work_item_id.clone(),
            admission_id: Some(link.admission_id.clone()),
            policy_id: Some(link.policy_id.clone()),
            live_executor_outcome_id: Some(link.live_executor_outcome_id.clone()),
            runtime_receipt_id: Some(link.runtime_receipt_id.0.clone()),
            provider_instance_id: link.provider_instance_id.clone(),
            callback_response_write_attempt_id: Some(
                link.callback_response_write_attempt_id.clone(),
            ),
            status: link_status(&link.status, &link.runtime_progress),
            blockers: link_blockers(link),
            runtime_progress: Some(runtime_progress_label(&link.runtime_progress)),
            callback_refs: link.callback_refs.clone(),
            evidence_refs: link.evidence_refs.clone(),
            provider_completion_recorded: link.provider_completion_recorded,
            provider_write_recorded: link.provider_write_recorded,
            task_completion_permitted: link.task_completion_permitted,
            review_acceptance_permitted: link.review_acceptance_permitted,
            callback_answer_permitted: false,
            cancellation_permitted: false,
            resume_permitted: false,
            scm_mutation_permitted: false,
            raw_callback_material_retained: link.raw_callback_material_retained,
            next_action: link_next_action(&link.status, &link.runtime_progress),
        }
    }
}

fn admission_status(status: &CodexAppServerCallbackResponseExecutorAdmissionStatus) -> String {
    match status {
        CodexAppServerCallbackResponseExecutorAdmissionStatus::AcceptedForExecutorHandoff => {
            "admitted"
        }
        CodexAppServerCallbackResponseExecutorAdmissionStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn admission_refs(record: &CodexAppServerCallbackResponseExecutorAdmissionRecord) -> Vec<String> {
    vec![
        format!("request:{}", record.request_id),
        format!("callback-response:{}", record.callback_response_id),
        format!("envelope:{}", record.envelope_id),
        format!("provider-callback:{}", record.provider_callback_id),
        format!("task:{}", record.task_id),
        format!("work-item:{}", record.work_item_id),
        format!(
            "write-attempt:{}",
            record.callback_response_write_attempt_id.0
        ),
        format!("idempotency:{}", record.idempotency_key.0),
    ]
}

fn admission_next_action(status: &CodexAppServerCallbackResponseExecutorAdmissionStatus) -> String {
    match status {
        CodexAppServerCallbackResponseExecutorAdmissionStatus::AcceptedForExecutorHandoff => {
            "wait_for_callback_response_execution_outcome"
        }
        CodexAppServerCallbackResponseExecutorAdmissionStatus::Blocked => {
            "repair_callback_response_executor_admission"
        }
    }
    .to_owned()
}

fn link_status(
    status: &CodexAppServerCallbackResponseExecutionReceiptLinkStatus,
    progress: &CodexAppServerCallbackResponseExecutionRuntimeProgress,
) -> String {
    match status {
        CodexAppServerCallbackResponseExecutionReceiptLinkStatus::Blocked(_) => {
            "blocked".to_owned()
        }
        CodexAppServerCallbackResponseExecutionReceiptLinkStatus::Linked => {
            runtime_progress_label(progress)
        }
    }
}

fn link_blockers(link: &CodexAppServerCallbackResponseExecutionReceiptLink) -> Vec<String> {
    match &link.status {
        CodexAppServerCallbackResponseExecutionReceiptLinkStatus::Linked => Vec::new(),
        CodexAppServerCallbackResponseExecutionReceiptLinkStatus::Blocked(blockers) => blockers
            .iter()
            .map(|blocker| format!("{blocker:?}"))
            .collect(),
    }
}

fn runtime_progress_label(
    progress: &CodexAppServerCallbackResponseExecutionRuntimeProgress,
) -> String {
    match progress {
        CodexAppServerCallbackResponseExecutionRuntimeProgress::Accepted => "accepted",
        CodexAppServerCallbackResponseExecutionRuntimeProgress::Completed => "completed",
        CodexAppServerCallbackResponseExecutionRuntimeProgress::Failed(_) => "failed",
        CodexAppServerCallbackResponseExecutionRuntimeProgress::TimedOut => "timed_out",
        CodexAppServerCallbackResponseExecutionRuntimeProgress::Blocked(_) => "blocked",
        CodexAppServerCallbackResponseExecutionRuntimeProgress::CleanupRequired(_) => {
            "cleanup_required"
        }
    }
    .to_owned()
}

fn link_next_action(
    status: &CodexAppServerCallbackResponseExecutionReceiptLinkStatus,
    progress: &CodexAppServerCallbackResponseExecutionRuntimeProgress,
) -> String {
    if matches!(
        status,
        CodexAppServerCallbackResponseExecutionReceiptLinkStatus::Blocked(_)
    ) {
        return "repair_callback_response_receipt_linkage".to_owned();
    }

    match progress {
        CodexAppServerCallbackResponseExecutionRuntimeProgress::Accepted => {
            "watch_for_callback_response_completion"
        }
        CodexAppServerCallbackResponseExecutionRuntimeProgress::Completed => {
            "inspect_receipt_without_accepting_review"
        }
        CodexAppServerCallbackResponseExecutionRuntimeProgress::Failed(_) => {
            "inspect_callback_response_failure"
        }
        CodexAppServerCallbackResponseExecutionRuntimeProgress::TimedOut => {
            "review_timeout_and_cleanup"
        }
        CodexAppServerCallbackResponseExecutionRuntimeProgress::Blocked(_) => {
            "repair_callback_response_executor_gate"
        }
        CodexAppServerCallbackResponseExecutionRuntimeProgress::CleanupRequired(_) => {
            "run_cleanup_or_repair_host"
        }
    }
    .to_owned()
}
