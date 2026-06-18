use super::integration::{NativeEffigyEvidenceRef, NativeEffigyScope};
use super::repair::NativeEffigyRepairHint;
use super::safety::contains_forbidden_effigy_term;
use crate::tools::{NativeRuntimeReceiptRef, NativeToolActionId};

/// Sanitized summary of an Effigy health check such as `effigy doctor`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeEffigyHealthSummary {
    pub status: NativeEffigyHealthStatus,
    pub scope: NativeEffigyScope,
    pub tool_action_id: Option<NativeToolActionId>,
    pub receipt_refs: Vec<NativeRuntimeReceiptRef>,
    pub evidence_refs: Vec<NativeEffigyEvidenceRef>,
    pub repair_hints: Vec<NativeEffigyRepairHint>,
    pub summary: Option<String>,
}

impl NativeEffigyHealthSummary {
    pub fn uses_sanitized_refs(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_effigy_term(summary))
            .unwrap_or(true)
            && self
                .receipt_refs
                .iter()
                .all(|receipt_ref| !contains_forbidden_effigy_term(&receipt_ref.0))
            && self
                .evidence_refs
                .iter()
                .all(|evidence_ref| !contains_forbidden_effigy_term(&evidence_ref.0))
            && self
                .repair_hints
                .iter()
                .all(NativeEffigyRepairHint::uses_sanitized_refs)
    }

    pub fn needs_repair(&self) -> bool {
        matches!(
            self.status,
            NativeEffigyHealthStatus::Warning
                | NativeEffigyHealthStatus::Error
                | NativeEffigyHealthStatus::Blocked
        ) || !self.repair_hints.is_empty()
    }
}

/// Health state summarized from an Effigy inspection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeEffigyHealthStatus {
    Ok,
    Warning,
    Error,
    Blocked,
    Unknown,
}
