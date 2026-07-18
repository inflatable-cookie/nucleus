use serde::{Deserialize, Serialize};

use crate::{
    codex_receipt_from_interruption_outcome, CodexAppServerInterruptionOutcomeRecord,
    CodexAppServerInterruptionOutcomeStatus,
};

use super::helpers::{source_status, source_summary};

/// Client-safe diagnostics for Codex interruption outcomes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CodexInterruptionDiagnosticsDto {
    pub outcomes: Vec<CodexInterruptionDiagnosticDto>,
    pub client_can_interrupt_provider: bool,
    pub client_can_recover_sessions: bool,
    pub client_can_mutate_tasks: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CodexInterruptionDiagnosticDto {
    pub request_id: String,
    pub admission_id: Option<String>,
    pub envelope_id: Option<String>,
    pub status: String,
    pub receipt_id: String,
    pub evidence_refs: Vec<String>,
    pub raw_payload_retained: bool,
    pub recovery_implied: bool,
    pub task_mutation_permitted: bool,
    pub next_action: String,
    pub summary: String,
}

pub fn codex_interruption_diagnostics(
    records: &[CodexAppServerInterruptionOutcomeRecord],
) -> CodexInterruptionDiagnosticsDto {
    CodexInterruptionDiagnosticsDto {
        outcomes: records
            .iter()
            .map(CodexInterruptionDiagnosticDto::from)
            .collect(),
        client_can_interrupt_provider: false,
        client_can_recover_sessions: false,
        client_can_mutate_tasks: false,
        source_status: source_status(records.len()),
        source_summary: Some(source_summary(
            records.len(),
            "Codex interruption diagnostics have no outcome records yet",
            "Codex interruption diagnostics loaded from sanitized outcomes",
        )),
    }
}

impl From<&CodexAppServerInterruptionOutcomeRecord> for CodexInterruptionDiagnosticDto {
    fn from(record: &CodexAppServerInterruptionOutcomeRecord) -> Self {
        let receipt = codex_receipt_from_interruption_outcome(record);

        Self {
            request_id: record.request_id.clone(),
            admission_id: record.admission_id.clone(),
            envelope_id: record.envelope_id.clone(),
            status: status_label(&record.status),
            receipt_id: receipt.receipt_id.0,
            evidence_refs: record.evidence_refs.clone(),
            raw_payload_retained: record.raw_payload_retained,
            recovery_implied: record.recovery_implied,
            task_mutation_permitted: record.task_mutation_permitted,
            next_action: next_action(&record.status),
            summary: record.summary.clone(),
        }
    }
}

fn status_label(status: &CodexAppServerInterruptionOutcomeStatus) -> String {
    match status {
        CodexAppServerInterruptionOutcomeStatus::Accepted => "accepted",
        CodexAppServerInterruptionOutcomeStatus::Blocked(_) => "blocked",
        CodexAppServerInterruptionOutcomeStatus::Failed(_) => "failed",
        CodexAppServerInterruptionOutcomeStatus::Unsupported(_) => "unsupported",
    }
    .to_owned()
}

fn next_action(status: &CodexAppServerInterruptionOutcomeStatus) -> String {
    match status {
        CodexAppServerInterruptionOutcomeStatus::Accepted => {
            "await_provider_interruption_observation"
        }
        CodexAppServerInterruptionOutcomeStatus::Blocked(_) => "repair_interruption_admission",
        CodexAppServerInterruptionOutcomeStatus::Failed(_) => "inspect_interruption_send_failure",
        CodexAppServerInterruptionOutcomeStatus::Unsupported(_) => {
            "promote_provider_interruption_capability_gap"
        }
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CodexAppServerInterruptionOutcomeId;

    #[test]
    fn interruption_diagnostics_serialize_without_raw_payload_or_authority() {
        let dto = codex_interruption_diagnostics(&[CodexAppServerInterruptionOutcomeRecord {
            outcome_id: CodexAppServerInterruptionOutcomeId(
                "codex-interruption-outcome:1".to_owned(),
            ),
            request_id: "interrupt:1".to_owned(),
            admission_id: Some("admission:1".to_owned()),
            envelope_id: Some("envelope:1".to_owned()),
            status: CodexAppServerInterruptionOutcomeStatus::Accepted,
            evidence_refs: vec!["evidence:interruption".to_owned()],
            raw_payload_retained: false,
            recovery_implied: false,
            task_mutation_permitted: false,
            summary: "Codex interruption accepted before provider send".to_owned(),
        }]);

        let json = serde_json::to_string(&dto).expect("serialize diagnostics");

        assert!(json.contains("\"raw_payload_retained\":false"));
        assert!(json.contains("\"client_can_interrupt_provider\":false"));
        assert!(json.contains("\"client_can_recover_sessions\":false"));
        assert!(json.contains("\"client_can_mutate_tasks\":false"));
        assert!(!json.contains("raw_provider_payload"));
        assert!(!json.contains("reason_ref"));
    }
}
