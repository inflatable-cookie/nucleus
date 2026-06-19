use serde::{Deserialize, Serialize};

use crate::{
    codex_receipt_from_recovery_outcome, CodexAppServerRecoveryOutcomeRecord,
    CodexAppServerRecoveryOutcomeStatus,
};

use super::helpers::{source_status, source_summary};

/// Client-safe diagnostics for Codex recovery outcomes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CodexRecoveryDiagnosticsDto {
    pub outcomes: Vec<CodexRecoveryDiagnosticDto>,
    pub client_can_resume_provider: bool,
    pub client_can_repair_sessions: bool,
    pub client_can_mutate_tasks: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CodexRecoveryDiagnosticDto {
    pub need_id: String,
    pub admission_id: Option<String>,
    pub envelope_id: Option<String>,
    pub provider_thread_id: Option<String>,
    pub replacement_thread_id: Option<String>,
    pub status: String,
    pub receipt_id: String,
    pub evidence_refs: Vec<String>,
    pub raw_payload_retained: bool,
    pub task_mutation_permitted: bool,
    pub next_action: String,
    pub summary: String,
}

pub fn codex_recovery_diagnostics(
    records: &[CodexAppServerRecoveryOutcomeRecord],
) -> CodexRecoveryDiagnosticsDto {
    CodexRecoveryDiagnosticsDto {
        outcomes: records
            .iter()
            .map(CodexRecoveryDiagnosticDto::from)
            .collect(),
        client_can_resume_provider: false,
        client_can_repair_sessions: false,
        client_can_mutate_tasks: false,
        source_status: source_status(records.len()),
        source_summary: Some(source_summary(
            records.len(),
            "Codex recovery diagnostics have no outcome records yet",
            "Codex recovery diagnostics loaded from sanitized outcomes",
        )),
    }
}

impl From<&CodexAppServerRecoveryOutcomeRecord> for CodexRecoveryDiagnosticDto {
    fn from(record: &CodexAppServerRecoveryOutcomeRecord) -> Self {
        let receipt = codex_receipt_from_recovery_outcome(record);

        Self {
            need_id: record.need_id.clone(),
            admission_id: record.admission_id.clone(),
            envelope_id: record.envelope_id.clone(),
            provider_thread_id: record.provider_thread_id.clone(),
            replacement_thread_id: record.replacement_thread_id.clone(),
            status: status_label(&record.status),
            receipt_id: receipt.receipt_id.0,
            evidence_refs: record.evidence_refs.clone(),
            raw_payload_retained: record.raw_payload_retained,
            task_mutation_permitted: record.task_mutation_permitted,
            next_action: next_action(&record.status),
            summary: record.summary.clone(),
        }
    }
}

fn status_label(status: &CodexAppServerRecoveryOutcomeStatus) -> String {
    match status {
        CodexAppServerRecoveryOutcomeStatus::ResumeAccepted => "resume_accepted",
        CodexAppServerRecoveryOutcomeStatus::Blocked(_) => "blocked",
        CodexAppServerRecoveryOutcomeStatus::RepairRequired(_) => "repair_required",
        CodexAppServerRecoveryOutcomeStatus::ReplacementThreadObserved(_) => {
            "replacement_thread_observed"
        }
        CodexAppServerRecoveryOutcomeStatus::Failed(_) => "failed",
        CodexAppServerRecoveryOutcomeStatus::Unsupported(_) => "unsupported",
    }
    .to_owned()
}

fn next_action(status: &CodexAppServerRecoveryOutcomeStatus) -> String {
    match status {
        CodexAppServerRecoveryOutcomeStatus::ResumeAccepted => "await_provider_resume_observation",
        CodexAppServerRecoveryOutcomeStatus::Blocked(_) => "repair_recovery_admission",
        CodexAppServerRecoveryOutcomeStatus::RepairRequired(_) => "repair_session_identity",
        CodexAppServerRecoveryOutcomeStatus::ReplacementThreadObserved(_) => {
            "review_replacement_thread_before_task_mutation"
        }
        CodexAppServerRecoveryOutcomeStatus::Failed(_) => "inspect_recovery_send_failure",
        CodexAppServerRecoveryOutcomeStatus::Unsupported(_) => {
            "promote_provider_recovery_capability_gap"
        }
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CodexAppServerRecoveryOutcomeId;

    #[test]
    fn recovery_diagnostics_serialize_without_raw_payload_or_command_authority() {
        let dto = codex_recovery_diagnostics(&[
            CodexAppServerRecoveryOutcomeRecord {
                outcome_id: CodexAppServerRecoveryOutcomeId("codex-recovery-outcome:1".to_owned()),
                need_id: "need:1".to_owned(),
                admission_id: Some("admission:1".to_owned()),
                envelope_id: Some("envelope:1".to_owned()),
                provider_thread_id: Some("thread:provider:1".to_owned()),
                replacement_thread_id: None,
                status: CodexAppServerRecoveryOutcomeStatus::ResumeAccepted,
                evidence_refs: vec!["evidence:recovery".to_owned()],
                raw_payload_retained: false,
                task_mutation_permitted: false,
                summary: "Codex recovery resume accepted before provider send".to_owned(),
            },
            CodexAppServerRecoveryOutcomeRecord {
                outcome_id: CodexAppServerRecoveryOutcomeId(
                    "codex-recovery-outcome:replacement".to_owned(),
                ),
                need_id: "need:2".to_owned(),
                admission_id: Some("admission:2".to_owned()),
                envelope_id: Some("envelope:2".to_owned()),
                provider_thread_id: Some("thread:provider:2".to_owned()),
                replacement_thread_id: Some("thread:replacement".to_owned()),
                status: CodexAppServerRecoveryOutcomeStatus::ReplacementThreadObserved(
                    "replacement thread observed".to_owned(),
                ),
                evidence_refs: vec!["evidence:replacement".to_owned()],
                raw_payload_retained: false,
                task_mutation_permitted: false,
                summary: "Codex recovery observed replacement thread".to_owned(),
            },
        ]);

        let json = serde_json::to_string(&dto).expect("serialize diagnostics");

        assert!(json.contains("\"client_can_resume_provider\":false"));
        assert!(json.contains("\"client_can_repair_sessions\":false"));
        assert!(json.contains("\"client_can_mutate_tasks\":false"));
        assert!(json.contains("replacement_thread_observed"));
        assert!(json.contains("review_replacement_thread_before_task_mutation"));
        assert!(!json.contains("raw_provider_payload"));
        assert!(!json.contains("provider_send_started"));
        assert!(!json.contains("recovery_authority_confirmed"));
    }
}
