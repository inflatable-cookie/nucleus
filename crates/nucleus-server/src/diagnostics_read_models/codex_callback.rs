use serde::{Deserialize, Serialize};

use crate::{
    codex_receipt_from_callback_response_outcome, CodexAppServerCallbackResponseOutcomeRecord,
    CodexAppServerCallbackResponseOutcomeStatus,
};

use super::helpers::{source_status, source_summary};

/// Client-safe diagnostics for Codex callback response outcomes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CodexCallbackDiagnosticsDto {
    pub outcomes: Vec<CodexCallbackDiagnosticDto>,
    pub client_can_answer_callbacks: bool,
    pub client_can_cancel_provider: bool,
    pub client_can_recover_sessions: bool,
    pub client_can_mutate_tasks: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CodexCallbackDiagnosticDto {
    pub request_id: String,
    pub admission_id: Option<String>,
    pub envelope_id: Option<String>,
    pub provider_callback_id: String,
    pub status: String,
    pub receipt_id: String,
    pub evidence_refs: Vec<String>,
    pub raw_payload_retained: bool,
    pub cancellation_implied: bool,
    pub task_mutation_permitted: bool,
    pub next_action: String,
    pub summary: String,
}

pub fn codex_callback_diagnostics(
    records: &[CodexAppServerCallbackResponseOutcomeRecord],
) -> CodexCallbackDiagnosticsDto {
    CodexCallbackDiagnosticsDto {
        outcomes: records
            .iter()
            .map(CodexCallbackDiagnosticDto::from)
            .collect(),
        client_can_answer_callbacks: false,
        client_can_cancel_provider: false,
        client_can_recover_sessions: false,
        client_can_mutate_tasks: false,
        source_status: source_status(records.len()),
        source_summary: Some(source_summary(
            records.len(),
            "Codex callback diagnostics have no outcome records yet",
            "Codex callback diagnostics loaded from sanitized outcomes",
        )),
    }
}

impl From<&CodexAppServerCallbackResponseOutcomeRecord> for CodexCallbackDiagnosticDto {
    fn from(record: &CodexAppServerCallbackResponseOutcomeRecord) -> Self {
        let receipt = codex_receipt_from_callback_response_outcome(record);

        Self {
            request_id: record.request_id.clone(),
            admission_id: record.admission_id.clone(),
            envelope_id: record.envelope_id.clone(),
            provider_callback_id: record.provider_callback_id.clone(),
            status: status_label(&record.status),
            receipt_id: receipt.receipt_id.0,
            evidence_refs: record.evidence_refs.clone(),
            raw_payload_retained: record.raw_payload_retained,
            cancellation_implied: record.cancellation_implied,
            task_mutation_permitted: record.task_mutation_permitted,
            next_action: next_action(&record.status),
            summary: record.summary.clone(),
        }
    }
}

fn status_label(status: &CodexAppServerCallbackResponseOutcomeStatus) -> String {
    match status {
        CodexAppServerCallbackResponseOutcomeStatus::Accepted => "accepted",
        CodexAppServerCallbackResponseOutcomeStatus::Blocked(_) => "blocked",
        CodexAppServerCallbackResponseOutcomeStatus::Failed(_) => "failed",
        CodexAppServerCallbackResponseOutcomeStatus::Unsupported(_) => "unsupported",
    }
    .to_owned()
}

fn next_action(status: &CodexAppServerCallbackResponseOutcomeStatus) -> String {
    match status {
        CodexAppServerCallbackResponseOutcomeStatus::Accepted => {
            "await_provider_resolution_observation"
        }
        CodexAppServerCallbackResponseOutcomeStatus::Blocked(_) => "repair_callback_admission",
        CodexAppServerCallbackResponseOutcomeStatus::Failed(_) => "inspect_callback_send_failure",
        CodexAppServerCallbackResponseOutcomeStatus::Unsupported(_) => {
            "promote_provider_callback_capability_gap"
        }
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CodexAppServerCallbackResponseOutcomeId;

    #[test]
    fn callback_diagnostics_serialize_without_response_payload_values() {
        let dto = codex_callback_diagnostics(&[CodexAppServerCallbackResponseOutcomeRecord {
            outcome_id: CodexAppServerCallbackResponseOutcomeId(
                "codex-callback-response-outcome:1".to_owned(),
            ),
            request_id: "request:1".to_owned(),
            admission_id: Some("admission:1".to_owned()),
            envelope_id: Some("envelope:1".to_owned()),
            provider_callback_id: "provider-callback:1".to_owned(),
            status: CodexAppServerCallbackResponseOutcomeStatus::Accepted,
            evidence_refs: vec!["evidence:callback".to_owned()],
            raw_payload_retained: false,
            cancellation_implied: false,
            task_mutation_permitted: false,
            summary: "Codex callback response accepted before provider send".to_owned(),
        }]);

        let json = serde_json::to_string(&dto).expect("serialize diagnostics");

        assert!(json.contains("\"raw_payload_retained\":false"));
        assert!(json.contains("\"client_can_answer_callbacks\":false"));
        assert!(!json.contains("selected_option"));
        assert!(!json.contains("values"));
        assert!(!json.contains("raw_provider_payload"));
    }
}
