use serde::{Deserialize, Serialize};

use crate::{
    CodexAppServerRecoveryExecutionReceiptLink, CodexAppServerRecoveryExecutionReceiptLinkStatus,
    CodexAppServerRecoveryExecutionRuntimeProgress, CodexAppServerRecoveryExecutorAdmissionRecord,
    CodexAppServerRecoveryExecutorAdmissionStatus,
};

use super::helpers::{source_status, source_summary};

/// Client-safe diagnostics for Codex provider recovery execution state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CodexRecoveryExecutionDiagnosticsDto {
    pub attempts: Vec<CodexRecoveryExecutionAttemptDiagnosticDto>,
    pub client_can_execute_provider_write: bool,
    pub client_can_resume_provider: bool,
    pub client_can_promote_replacement_thread: bool,
    pub client_can_interrupt_provider: bool,
    pub client_can_answer_callbacks: bool,
    pub client_can_mutate_tasks: bool,
    pub client_can_accept_review: bool,
    pub client_can_mutate_scm: bool,
    pub provider_material_exposed: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

/// One recovery execution attempt visible to diagnostics clients.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CodexRecoveryExecutionAttemptDiagnosticDto {
    pub need_id: String,
    pub envelope_id: String,
    pub provider_thread_id: String,
    pub provider_turn_id: Option<String>,
    pub provider_request_id: Option<String>,
    pub task_id: String,
    pub work_item_id: String,
    pub admission_id: Option<String>,
    pub policy_id: Option<String>,
    pub live_executor_outcome_id: Option<String>,
    pub runtime_receipt_id: Option<String>,
    pub provider_instance_id: String,
    pub recovery_write_attempt_id: Option<String>,
    pub status: String,
    pub blockers: Vec<String>,
    pub runtime_progress: Option<String>,
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
    pub next_action: String,
}

pub fn codex_recovery_execution_diagnostics(
    admissions: &[CodexAppServerRecoveryExecutorAdmissionRecord],
    links: &[CodexAppServerRecoveryExecutionReceiptLink],
) -> CodexRecoveryExecutionDiagnosticsDto {
    let mut attempts = admissions
        .iter()
        .map(CodexRecoveryExecutionAttemptDiagnosticDto::from)
        .collect::<Vec<_>>();
    attempts.extend(
        links
            .iter()
            .map(CodexRecoveryExecutionAttemptDiagnosticDto::from),
    );

    CodexRecoveryExecutionDiagnosticsDto {
        source_status: source_status(attempts.len()),
        source_summary: Some(source_summary(
            attempts.len(),
            "Codex recovery execution diagnostics have no records yet",
            "Codex recovery execution diagnostics loaded from sanitized refs",
        )),
        attempts,
        client_can_execute_provider_write: false,
        client_can_resume_provider: false,
        client_can_promote_replacement_thread: false,
        client_can_interrupt_provider: false,
        client_can_answer_callbacks: false,
        client_can_mutate_tasks: false,
        client_can_accept_review: false,
        client_can_mutate_scm: false,
        provider_material_exposed: false,
    }
}

impl From<&CodexAppServerRecoveryExecutorAdmissionRecord>
    for CodexRecoveryExecutionAttemptDiagnosticDto
{
    fn from(record: &CodexAppServerRecoveryExecutorAdmissionRecord) -> Self {
        Self {
            need_id: record.need_id.clone(),
            envelope_id: record.envelope_id.clone(),
            provider_thread_id: record.provider_thread_id.clone(),
            provider_turn_id: record.provider_turn_id.clone(),
            provider_request_id: record.provider_request_id.clone(),
            task_id: record.task_id.clone(),
            work_item_id: record.work_item_id.clone(),
            admission_id: Some(record.admission_id.0.clone()),
            policy_id: Some(record.policy_id.clone()),
            live_executor_outcome_id: None,
            runtime_receipt_id: None,
            provider_instance_id: record.provider_instance_id.clone(),
            recovery_write_attempt_id: Some(record.recovery_write_attempt_id.0.clone()),
            status: admission_status(&record.status),
            blockers: record
                .blockers
                .iter()
                .map(|blocker| format!("{blocker:?}"))
                .collect(),
            runtime_progress: None,
            recovery_refs: admission_refs(record),
            evidence_refs: record.evidence_refs.clone(),
            provider_completion_recorded: false,
            provider_write_recorded: record.provider_write_executed,
            replacement_thread_observed: false,
            task_completion_permitted: record.task_mutation_permitted,
            review_acceptance_permitted: record.review_acceptance_permitted,
            replacement_thread_promotion_permitted: record.replacement_thread_promotion_permitted,
            interruption_permitted: record.interruption_permitted,
            callback_answer_permitted: record.callback_answer_permitted,
            scm_mutation_permitted: record.scm_mutation_permitted,
            raw_provider_material_retained: record.raw_provider_material_retained,
            raw_callback_material_retained: record.raw_callback_material_retained,
            next_action: admission_next_action(&record.status),
        }
    }
}

impl From<&CodexAppServerRecoveryExecutionReceiptLink>
    for CodexRecoveryExecutionAttemptDiagnosticDto
{
    fn from(link: &CodexAppServerRecoveryExecutionReceiptLink) -> Self {
        Self {
            need_id: link.need_id.clone(),
            envelope_id: link.envelope_id.clone(),
            provider_thread_id: link.provider_thread_id.clone(),
            provider_turn_id: link.provider_turn_id.clone(),
            provider_request_id: link.provider_request_id.clone(),
            task_id: link.task_id.clone(),
            work_item_id: link.work_item_id.clone(),
            admission_id: Some(link.admission_id.clone()),
            policy_id: Some(link.policy_id.clone()),
            live_executor_outcome_id: Some(link.live_executor_outcome_id.clone()),
            runtime_receipt_id: Some(link.runtime_receipt_id.0.clone()),
            provider_instance_id: link.provider_instance_id.clone(),
            recovery_write_attempt_id: Some(link.recovery_write_attempt_id.clone()),
            status: link_status(&link.status, &link.runtime_progress),
            blockers: link_blockers(link),
            runtime_progress: Some(runtime_progress_label(&link.runtime_progress)),
            recovery_refs: link.recovery_refs.clone(),
            evidence_refs: link.evidence_refs.clone(),
            provider_completion_recorded: link.provider_completion_recorded,
            provider_write_recorded: link.provider_write_recorded,
            replacement_thread_observed: link.replacement_thread_observed,
            task_completion_permitted: link.task_completion_permitted,
            review_acceptance_permitted: link.review_acceptance_permitted,
            replacement_thread_promotion_permitted: link.replacement_thread_promotion_permitted,
            interruption_permitted: link.interruption_permitted,
            callback_answer_permitted: link.callback_answer_permitted,
            scm_mutation_permitted: link.scm_mutation_permitted,
            raw_provider_material_retained: link.raw_provider_material_retained,
            raw_callback_material_retained: link.raw_callback_material_retained,
            next_action: link_next_action(&link.status, &link.runtime_progress),
        }
    }
}

fn admission_status(status: &CodexAppServerRecoveryExecutorAdmissionStatus) -> String {
    match status {
        CodexAppServerRecoveryExecutorAdmissionStatus::AcceptedForExecutorHandoff => "admitted",
        CodexAppServerRecoveryExecutorAdmissionStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn admission_refs(record: &CodexAppServerRecoveryExecutorAdmissionRecord) -> Vec<String> {
    let mut refs = vec![
        format!("need:{}", record.need_id),
        format!("envelope:{}", record.envelope_id),
        format!("provider-thread:{}", record.provider_thread_id),
        format!("task:{}", record.task_id),
        format!("work-item:{}", record.work_item_id),
        format!("write-attempt:{}", record.recovery_write_attempt_id.0),
        format!("idempotency:{}", record.idempotency_key.0),
    ];
    if let Some(provider_turn_id) = &record.provider_turn_id {
        refs.push(format!("provider-turn:{provider_turn_id}"));
    }
    if let Some(provider_request_id) = &record.provider_request_id {
        refs.push(format!("provider-request:{provider_request_id}"));
    }
    refs
}

fn admission_next_action(status: &CodexAppServerRecoveryExecutorAdmissionStatus) -> String {
    match status {
        CodexAppServerRecoveryExecutorAdmissionStatus::AcceptedForExecutorHandoff => {
            "wait_for_recovery_execution_outcome"
        }
        CodexAppServerRecoveryExecutorAdmissionStatus::Blocked => {
            "repair_recovery_executor_admission"
        }
    }
    .to_owned()
}

fn link_status(
    status: &CodexAppServerRecoveryExecutionReceiptLinkStatus,
    progress: &CodexAppServerRecoveryExecutionRuntimeProgress,
) -> String {
    match status {
        CodexAppServerRecoveryExecutionReceiptLinkStatus::Blocked(_) => "blocked".to_owned(),
        CodexAppServerRecoveryExecutionReceiptLinkStatus::Linked => {
            runtime_progress_label(progress)
        }
    }
}

fn link_blockers(link: &CodexAppServerRecoveryExecutionReceiptLink) -> Vec<String> {
    match &link.status {
        CodexAppServerRecoveryExecutionReceiptLinkStatus::Linked => Vec::new(),
        CodexAppServerRecoveryExecutionReceiptLinkStatus::Blocked(blockers) => blockers
            .iter()
            .map(|blocker| format!("{blocker:?}"))
            .collect(),
    }
}

fn runtime_progress_label(progress: &CodexAppServerRecoveryExecutionRuntimeProgress) -> String {
    match progress {
        CodexAppServerRecoveryExecutionRuntimeProgress::Accepted => "accepted",
        CodexAppServerRecoveryExecutionRuntimeProgress::Completed => "completed",
        CodexAppServerRecoveryExecutionRuntimeProgress::Failed(_) => "failed",
        CodexAppServerRecoveryExecutionRuntimeProgress::TimedOut => "timed_out",
        CodexAppServerRecoveryExecutionRuntimeProgress::Blocked(_) => "blocked",
        CodexAppServerRecoveryExecutionRuntimeProgress::CleanupRequired(_) => "cleanup_required",
        CodexAppServerRecoveryExecutionRuntimeProgress::ReplacementThreadObserved(_) => {
            "replacement_thread_observed"
        }
    }
    .to_owned()
}

fn link_next_action(
    status: &CodexAppServerRecoveryExecutionReceiptLinkStatus,
    progress: &CodexAppServerRecoveryExecutionRuntimeProgress,
) -> String {
    if matches!(
        status,
        CodexAppServerRecoveryExecutionReceiptLinkStatus::Blocked(_)
    ) {
        return "repair_recovery_receipt_linkage".to_owned();
    }

    match progress {
        CodexAppServerRecoveryExecutionRuntimeProgress::Accepted => "watch_for_recovery_completion",
        CodexAppServerRecoveryExecutionRuntimeProgress::Completed => {
            "inspect_receipt_without_promoting_replacement_thread"
        }
        CodexAppServerRecoveryExecutionRuntimeProgress::Failed(_) => "inspect_recovery_failure",
        CodexAppServerRecoveryExecutionRuntimeProgress::TimedOut => "inspect_recovery_timeout",
        CodexAppServerRecoveryExecutionRuntimeProgress::Blocked(_) => "inspect_recovery_blocker",
        CodexAppServerRecoveryExecutionRuntimeProgress::CleanupRequired(_) => {
            "inspect_recovery_cleanup_requirement"
        }
        CodexAppServerRecoveryExecutionRuntimeProgress::ReplacementThreadObserved(_) => {
            "open_explicit_replacement_thread_repair"
        }
    }
    .to_owned()
}
