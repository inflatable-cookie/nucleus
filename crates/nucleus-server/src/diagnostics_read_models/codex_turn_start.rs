use serde::{Deserialize, Serialize};

use crate::{
    codex_receipt_from_turn_start_outcome, CodexAppServerTurnStartOutcomeRecord,
    CodexAppServerTurnStartOutcomeStatus,
};

use super::helpers::{source_status, source_summary};

/// Client-safe diagnostics for Codex turn-start outcomes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CodexTurnStartDiagnosticsDto {
    pub outcomes: Vec<CodexTurnStartDiagnosticDto>,
    pub client_can_start_turns: bool,
    pub client_can_answer_callbacks: bool,
    pub client_can_mutate_tasks: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CodexTurnStartDiagnosticDto {
    pub request_id: String,
    pub admission_id: Option<String>,
    pub envelope_id: Option<String>,
    pub status: String,
    pub receipt_id: String,
    pub evidence_refs: Vec<String>,
    pub raw_payload_retained: bool,
    pub task_mutation_permitted: bool,
    pub next_action: String,
    pub summary: String,
}

pub fn codex_turn_start_diagnostics(
    records: &[CodexAppServerTurnStartOutcomeRecord],
) -> CodexTurnStartDiagnosticsDto {
    CodexTurnStartDiagnosticsDto {
        outcomes: records
            .iter()
            .map(CodexTurnStartDiagnosticDto::from)
            .collect(),
        client_can_start_turns: false,
        client_can_answer_callbacks: false,
        client_can_mutate_tasks: false,
        source_status: source_status(records.len()),
        source_summary: Some(source_summary(
            records.len(),
            "Codex turn-start diagnostics have no outcome records yet",
            "Codex turn-start diagnostics loaded from sanitized outcomes",
        )),
    }
}

impl From<&CodexAppServerTurnStartOutcomeRecord> for CodexTurnStartDiagnosticDto {
    fn from(record: &CodexAppServerTurnStartOutcomeRecord) -> Self {
        let receipt = codex_receipt_from_turn_start_outcome(record);

        Self {
            request_id: record.request_id.clone(),
            admission_id: record.admission_id.clone(),
            envelope_id: record.envelope_id.clone(),
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

fn status_label(status: &CodexAppServerTurnStartOutcomeStatus) -> String {
    match status {
        CodexAppServerTurnStartOutcomeStatus::Accepted => "accepted",
        CodexAppServerTurnStartOutcomeStatus::Blocked(_) => "blocked",
        CodexAppServerTurnStartOutcomeStatus::Failed(_) => "failed",
        CodexAppServerTurnStartOutcomeStatus::Unsupported(_) => "unsupported",
    }
    .to_owned()
}

fn next_action(status: &CodexAppServerTurnStartOutcomeStatus) -> String {
    match status {
        CodexAppServerTurnStartOutcomeStatus::Accepted => "wait_for_provider_observations",
        CodexAppServerTurnStartOutcomeStatus::Blocked(_) => "repair_admission_inputs",
        CodexAppServerTurnStartOutcomeStatus::Failed(_) => "inspect_turn_start_failure",
        CodexAppServerTurnStartOutcomeStatus::Unsupported(_) => "promote_provider_capability_gap",
    }
    .to_owned()
}
