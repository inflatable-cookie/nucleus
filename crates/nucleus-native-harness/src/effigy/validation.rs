/// Sanitized `effigy test --plan` summary.
use super::integration::{
    NativeEffigyCommandScopeHint, NativeEffigyEvidenceRef, NativeEffigyScope,
    NativeEffigySelectorRef,
};
use super::repair::NativeEffigyRepairHint;
use super::safety::contains_forbidden_effigy_term;
use crate::tools::{NativeRuntimeReceiptRef, NativeToolActionId};

/// Sanitized `effigy test --plan` summary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeEffigyValidationPlanSummary {
    pub status: NativeEffigyValidationPlanStatus,
    pub scope: NativeEffigyScope,
    pub tool_action_id: Option<NativeToolActionId>,
    pub planned_selectors: Vec<NativeEffigyPlannedSelector>,
    pub receipt_refs: Vec<NativeRuntimeReceiptRef>,
    pub evidence_refs: Vec<NativeEffigyEvidenceRef>,
    pub repair_hints: Vec<NativeEffigyRepairHint>,
    pub summary: Option<String>,
}

impl NativeEffigyValidationPlanSummary {
    pub fn planned_only(
        scope: NativeEffigyScope,
        planned_selectors: Vec<NativeEffigyPlannedSelector>,
    ) -> Self {
        Self {
            status: NativeEffigyValidationPlanStatus::PlannedOnly,
            scope,
            tool_action_id: None,
            planned_selectors,
            receipt_refs: Vec::new(),
            evidence_refs: Vec::new(),
            repair_hints: Vec::new(),
            summary: None,
        }
    }

    pub fn claims_execution(&self) -> bool {
        self.status == NativeEffigyValidationPlanStatus::Executed
    }

    pub fn uses_sanitized_refs(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_effigy_term(summary))
            .unwrap_or(true)
            && self
                .planned_selectors
                .iter()
                .all(NativeEffigyPlannedSelector::uses_sanitized_refs)
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
}

/// Validation-plan state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeEffigyValidationPlanStatus {
    PlannedOnly,
    Executed,
    Unsupported,
    Blocked,
    Unknown,
}

/// One selector named by a validation plan.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeEffigyPlannedSelector {
    pub selector_ref: NativeEffigySelectorRef,
    pub purpose: NativeEffigyValidationPurpose,
    pub command_scope_hint: NativeEffigyCommandScopeHint,
    pub evidence_refs: Vec<NativeEffigyEvidenceRef>,
}

impl NativeEffigyPlannedSelector {
    pub fn uses_sanitized_refs(&self) -> bool {
        !contains_forbidden_effigy_term(&self.selector_ref.0)
            && self
                .evidence_refs
                .iter()
                .all(|evidence_ref| !contains_forbidden_effigy_term(&evidence_ref.0))
    }
}

/// Reason a selector appears in a validation plan.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeEffigyValidationPurpose {
    Setup,
    Validation,
    Health,
    Check,
    ReleaseGate,
    Custom(String),
}
