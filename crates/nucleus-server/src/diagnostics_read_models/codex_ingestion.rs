use serde::{Deserialize, Serialize};

use crate::{CodexTaskRuntimeObservationLink, CodexTaskRuntimeObservationLinkStatus};

use super::helpers::{source_status, source_summary};

/// Client-safe diagnostics for Codex ingestion acceptance.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CodexIngestionDiagnosticsDto {
    pub observations: Vec<CodexIngestionObservationDiagnosticDto>,
    pub client_can_mutate_observations: bool,
    pub provider_execution_available: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

/// One Codex observation visible to diagnostics clients.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CodexIngestionObservationDiagnosticDto {
    pub source_id: String,
    pub binding_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub status: String,
    pub event_store_event_id: Option<String>,
    pub receipt_id: Option<String>,
    pub evidence_refs: Vec<String>,
    pub next_action: String,
    pub permits_task_state_mutation: bool,
    pub summary: String,
}

pub fn codex_ingestion_diagnostics(
    links: &[CodexTaskRuntimeObservationLink],
) -> CodexIngestionDiagnosticsDto {
    CodexIngestionDiagnosticsDto {
        observations: links
            .iter()
            .map(CodexIngestionObservationDiagnosticDto::from)
            .collect(),
        client_can_mutate_observations: false,
        provider_execution_available: false,
        source_status: source_status(links.len()),
        source_summary: Some(source_summary(
            links.len(),
            "Codex ingestion observations are not persisted yet",
            "Codex ingestion diagnostics loaded from observation links",
        )),
    }
}

impl From<&CodexTaskRuntimeObservationLink> for CodexIngestionObservationDiagnosticDto {
    fn from(link: &CodexTaskRuntimeObservationLink) -> Self {
        Self {
            source_id: link.source_id.clone(),
            binding_id: link.binding_id.clone(),
            task_id: link.task_id.0.clone(),
            work_item_id: link.work_item_id.0.clone(),
            status: observation_status(&link.status),
            event_store_event_id: link.event_store_event_id.clone(),
            receipt_id: link.receipt_id.clone(),
            evidence_refs: link.evidence_refs.clone(),
            next_action: next_action(&link.status),
            permits_task_state_mutation: link.permits_task_state_mutation,
            summary: link.summary.clone(),
        }
    }
}

fn observation_status(status: &CodexTaskRuntimeObservationLinkStatus) -> String {
    match status {
        CodexTaskRuntimeObservationLinkStatus::Linked => "linked",
        CodexTaskRuntimeObservationLinkStatus::ReceiptOnly => "receipt_only",
        CodexTaskRuntimeObservationLinkStatus::NotLinked(_) => "not_linked",
    }
    .to_owned()
}

fn next_action(status: &CodexTaskRuntimeObservationLinkStatus) -> String {
    match status {
        CodexTaskRuntimeObservationLinkStatus::Linked => "none",
        CodexTaskRuntimeObservationLinkStatus::ReceiptOnly => "review_receipt",
        CodexTaskRuntimeObservationLinkStatus::NotLinked(reason)
            if reason.to_ascii_lowercase().contains("duplicate") =>
        {
            "ignore_duplicate"
        }
        CodexTaskRuntimeObservationLinkStatus::NotLinked(reason)
            if reason.to_ascii_lowercase().contains("unsupported") =>
        {
            "promote_mapping_or_record_diagnostic"
        }
        CodexTaskRuntimeObservationLinkStatus::NotLinked(reason)
            if reason.to_ascii_lowercase().contains("recovery") =>
        {
            "repair_or_recover_session"
        }
        CodexTaskRuntimeObservationLinkStatus::NotLinked(_) => "inspect_observation",
    }
    .to_owned()
}
