use serde::{Deserialize, Serialize};

use crate::{
    CodexAppServerInterruptionExecutionReceiptLink,
    CodexAppServerInterruptionExecutionReceiptLinkStatus,
    CodexAppServerInterruptionExecutionRuntimeProgress,
    CodexAppServerInterruptionExecutorAdmissionRecord,
    CodexAppServerInterruptionExecutorAdmissionStatus,
};

use super::helpers::{source_status, source_summary};

/// Client-safe diagnostics for Codex provider interruption execution state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CodexInterruptionExecutionDiagnosticsDto {
    pub attempts: Vec<CodexInterruptionExecutionAttemptDiagnosticDto>,
    pub client_can_execute_provider_write: bool,
    pub client_can_interrupt_provider: bool,
    pub client_can_mutate_tasks: bool,
    pub client_can_accept_review: bool,
    pub client_can_answer_callbacks: bool,
    pub client_can_resume_provider: bool,
    pub client_can_mutate_scm: bool,
    pub provider_material_exposed: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

/// One interruption execution attempt visible to diagnostics clients.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CodexInterruptionExecutionAttemptDiagnosticDto {
    pub request_id: String,
    pub envelope_id: String,
    pub provider_turn_id: String,
    pub provider_request_id: Option<String>,
    pub task_id: String,
    pub work_item_id: String,
    pub admission_id: Option<String>,
    pub policy_id: Option<String>,
    pub live_executor_outcome_id: Option<String>,
    pub runtime_receipt_id: Option<String>,
    pub provider_instance_id: String,
    pub interruption_write_attempt_id: Option<String>,
    pub status: String,
    pub blockers: Vec<String>,
    pub runtime_progress: Option<String>,
    pub interruption_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub provider_completion_recorded: bool,
    pub provider_write_recorded: bool,
    pub task_completion_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub callback_answer_permitted: bool,
    pub resume_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub raw_provider_material_retained: bool,
    pub raw_callback_material_retained: bool,
    pub next_action: String,
}

pub fn codex_interruption_execution_diagnostics(
    admissions: &[CodexAppServerInterruptionExecutorAdmissionRecord],
    links: &[CodexAppServerInterruptionExecutionReceiptLink],
) -> CodexInterruptionExecutionDiagnosticsDto {
    let mut attempts = admissions
        .iter()
        .map(CodexInterruptionExecutionAttemptDiagnosticDto::from)
        .collect::<Vec<_>>();
    attempts.extend(
        links
            .iter()
            .map(CodexInterruptionExecutionAttemptDiagnosticDto::from),
    );

    CodexInterruptionExecutionDiagnosticsDto {
        source_status: source_status(attempts.len()),
        source_summary: Some(source_summary(
            attempts.len(),
            "Codex interruption execution diagnostics have no records yet",
            "Codex interruption execution diagnostics loaded from sanitized refs",
        )),
        attempts,
        client_can_execute_provider_write: false,
        client_can_interrupt_provider: false,
        client_can_mutate_tasks: false,
        client_can_accept_review: false,
        client_can_answer_callbacks: false,
        client_can_resume_provider: false,
        client_can_mutate_scm: false,
        provider_material_exposed: false,
    }
}

impl From<&CodexAppServerInterruptionExecutorAdmissionRecord>
    for CodexInterruptionExecutionAttemptDiagnosticDto
{
    fn from(record: &CodexAppServerInterruptionExecutorAdmissionRecord) -> Self {
        Self {
            request_id: record.request_id.clone(),
            envelope_id: record.envelope_id.clone(),
            provider_turn_id: record.provider_turn_id.clone(),
            provider_request_id: record.provider_request_id.clone(),
            task_id: record.task_id.clone(),
            work_item_id: record.work_item_id.clone(),
            admission_id: Some(record.admission_id.0.clone()),
            policy_id: Some(record.policy_id.clone()),
            live_executor_outcome_id: None,
            runtime_receipt_id: None,
            provider_instance_id: record.provider_instance_id.clone(),
            interruption_write_attempt_id: Some(record.interruption_write_attempt_id.0.clone()),
            status: admission_status(&record.status),
            blockers: record
                .blockers
                .iter()
                .map(|blocker| format!("{blocker:?}"))
                .collect(),
            runtime_progress: None,
            interruption_refs: admission_refs(record),
            evidence_refs: record.evidence_refs.clone(),
            provider_completion_recorded: false,
            provider_write_recorded: record.provider_write_executed,
            task_completion_permitted: record.task_mutation_permitted,
            review_acceptance_permitted: record.review_acceptance_permitted,
            callback_answer_permitted: record.callback_answer_permitted,
            resume_permitted: record.resume_permitted,
            scm_mutation_permitted: record.scm_mutation_permitted,
            raw_provider_material_retained: record.raw_provider_material_retained,
            raw_callback_material_retained: record.raw_callback_material_retained,
            next_action: admission_next_action(&record.status),
        }
    }
}

impl From<&CodexAppServerInterruptionExecutionReceiptLink>
    for CodexInterruptionExecutionAttemptDiagnosticDto
{
    fn from(link: &CodexAppServerInterruptionExecutionReceiptLink) -> Self {
        Self {
            request_id: link.request_id.clone(),
            envelope_id: link.envelope_id.clone(),
            provider_turn_id: link.provider_turn_id.clone(),
            provider_request_id: link.provider_request_id.clone(),
            task_id: link.task_id.clone(),
            work_item_id: link.work_item_id.clone(),
            admission_id: Some(link.admission_id.clone()),
            policy_id: Some(link.policy_id.clone()),
            live_executor_outcome_id: Some(link.live_executor_outcome_id.clone()),
            runtime_receipt_id: Some(link.runtime_receipt_id.0.clone()),
            provider_instance_id: link.provider_instance_id.clone(),
            interruption_write_attempt_id: Some(link.interruption_write_attempt_id.clone()),
            status: link_status(&link.status, &link.runtime_progress),
            blockers: link_blockers(link),
            runtime_progress: Some(runtime_progress_label(&link.runtime_progress)),
            interruption_refs: link.interruption_refs.clone(),
            evidence_refs: link.evidence_refs.clone(),
            provider_completion_recorded: link.provider_completion_recorded,
            provider_write_recorded: link.provider_write_recorded,
            task_completion_permitted: link.task_completion_permitted,
            review_acceptance_permitted: link.review_acceptance_permitted,
            callback_answer_permitted: link.callback_answer_permitted,
            resume_permitted: link.resume_permitted,
            scm_mutation_permitted: link.scm_mutation_permitted,
            raw_provider_material_retained: link.raw_provider_material_retained,
            raw_callback_material_retained: link.raw_callback_material_retained,
            next_action: link_next_action(&link.status, &link.runtime_progress),
        }
    }
}

fn admission_status(status: &CodexAppServerInterruptionExecutorAdmissionStatus) -> String {
    match status {
        CodexAppServerInterruptionExecutorAdmissionStatus::AcceptedForExecutorHandoff => "admitted",
        CodexAppServerInterruptionExecutorAdmissionStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn admission_refs(record: &CodexAppServerInterruptionExecutorAdmissionRecord) -> Vec<String> {
    let mut refs = vec![
        format!("request:{}", record.request_id),
        format!("envelope:{}", record.envelope_id),
        format!("provider-turn:{}", record.provider_turn_id),
        format!("task:{}", record.task_id),
        format!("work-item:{}", record.work_item_id),
        format!("write-attempt:{}", record.interruption_write_attempt_id.0),
        format!("idempotency:{}", record.idempotency_key.0),
    ];
    if let Some(provider_request_id) = &record.provider_request_id {
        refs.push(format!("provider-request:{provider_request_id}"));
    }
    refs
}

fn admission_next_action(status: &CodexAppServerInterruptionExecutorAdmissionStatus) -> String {
    match status {
        CodexAppServerInterruptionExecutorAdmissionStatus::AcceptedForExecutorHandoff => {
            "wait_for_interruption_execution_outcome"
        }
        CodexAppServerInterruptionExecutorAdmissionStatus::Blocked => {
            "repair_interruption_executor_admission"
        }
    }
    .to_owned()
}

fn link_status(
    status: &CodexAppServerInterruptionExecutionReceiptLinkStatus,
    progress: &CodexAppServerInterruptionExecutionRuntimeProgress,
) -> String {
    match status {
        CodexAppServerInterruptionExecutionReceiptLinkStatus::Blocked(_) => "blocked".to_owned(),
        CodexAppServerInterruptionExecutionReceiptLinkStatus::Linked => {
            runtime_progress_label(progress)
        }
    }
}

fn link_blockers(link: &CodexAppServerInterruptionExecutionReceiptLink) -> Vec<String> {
    match &link.status {
        CodexAppServerInterruptionExecutionReceiptLinkStatus::Linked => Vec::new(),
        CodexAppServerInterruptionExecutionReceiptLinkStatus::Blocked(blockers) => blockers
            .iter()
            .map(|blocker| format!("{blocker:?}"))
            .collect(),
    }
}

fn runtime_progress_label(progress: &CodexAppServerInterruptionExecutionRuntimeProgress) -> String {
    match progress {
        CodexAppServerInterruptionExecutionRuntimeProgress::Accepted => "accepted",
        CodexAppServerInterruptionExecutionRuntimeProgress::Completed => "completed",
        CodexAppServerInterruptionExecutionRuntimeProgress::Failed(_) => "failed",
        CodexAppServerInterruptionExecutionRuntimeProgress::TimedOut => "timed_out",
        CodexAppServerInterruptionExecutionRuntimeProgress::Blocked(_) => "blocked",
        CodexAppServerInterruptionExecutionRuntimeProgress::CleanupRequired(_) => {
            "cleanup_required"
        }
    }
    .to_owned()
}

fn link_next_action(
    status: &CodexAppServerInterruptionExecutionReceiptLinkStatus,
    progress: &CodexAppServerInterruptionExecutionRuntimeProgress,
) -> String {
    if matches!(
        status,
        CodexAppServerInterruptionExecutionReceiptLinkStatus::Blocked(_)
    ) {
        return "repair_interruption_receipt_linkage".to_owned();
    }

    match progress {
        CodexAppServerInterruptionExecutionRuntimeProgress::Accepted => {
            "watch_for_interruption_completion"
        }
        CodexAppServerInterruptionExecutionRuntimeProgress::Completed => {
            "inspect_receipt_without_accepting_review"
        }
        CodexAppServerInterruptionExecutionRuntimeProgress::Failed(_) => {
            "inspect_interruption_failure"
        }
        CodexAppServerInterruptionExecutionRuntimeProgress::TimedOut => {
            "review_timeout_and_cleanup"
        }
        CodexAppServerInterruptionExecutionRuntimeProgress::Blocked(_) => {
            "repair_interruption_executor_gate"
        }
        CodexAppServerInterruptionExecutionRuntimeProgress::CleanupRequired(_) => {
            "run_cleanup_or_repair_host"
        }
    }
    .to_owned()
}
