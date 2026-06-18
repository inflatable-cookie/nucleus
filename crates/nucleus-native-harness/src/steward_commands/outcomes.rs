use crate::steward::{
    NativeStewardEvidenceRef, NativeStewardProposalId, NativeStewardSyncAssistanceId,
};
use crate::tools::{NativeRuntimeReceiptRef, NativeToolActionId};

use super::records::{NativeStewardCommandId, NativeStewardCommandStatus};
use super::safety::contains_forbidden_steward_command_term;

/// Steward command result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeStewardCommandOutcome {
    pub command_id: NativeStewardCommandId,
    pub status: NativeStewardCommandStatus,
    pub proposal_refs: Vec<NativeStewardProposalId>,
    pub sync_assistance_refs: Vec<NativeStewardSyncAssistanceId>,
    pub tool_action_id: Option<NativeToolActionId>,
    pub receipt_refs: Vec<NativeRuntimeReceiptRef>,
    pub evidence_refs: Vec<NativeStewardEvidenceRef>,
    pub summary: Option<String>,
}

impl NativeStewardCommandOutcome {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.status,
            NativeStewardCommandStatus::Rejected(_)
                | NativeStewardCommandStatus::Blocked(_)
                | NativeStewardCommandStatus::Completed
                | NativeStewardCommandStatus::CompletedWithWarnings
        )
    }

    pub fn is_distinct_from_mutation(&self) -> bool {
        true
    }

    pub fn can_imply_provider_authority(&self) -> bool {
        false
    }

    pub fn uses_reference_only_evidence(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_steward_command_term(summary))
            .unwrap_or(true)
            && self
                .receipt_refs
                .iter()
                .all(|receipt_ref| !contains_forbidden_steward_command_term(&receipt_ref.0))
            && self
                .evidence_refs
                .iter()
                .all(NativeStewardEvidenceRef::uses_reference_only_evidence)
    }

    pub fn with_receipt_link(mut self, link: &NativeStewardCommandReceiptLink) -> Self {
        for receipt_ref in &link.receipt_refs {
            if !self.receipt_refs.contains(receipt_ref) {
                self.receipt_refs.push(receipt_ref.clone());
            }
        }
        for evidence_ref in &link.evidence_refs {
            if !self.evidence_refs.contains(evidence_ref) {
                self.evidence_refs.push(evidence_ref.clone());
            }
        }
        if self.tool_action_id.is_none() {
            self.tool_action_id = link.tool_action_id.clone();
        }
        self
    }
}

/// Receipt and evidence linkage for a steward command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeStewardCommandReceiptLink {
    pub command_id: NativeStewardCommandId,
    pub tool_action_id: Option<NativeToolActionId>,
    pub receipt_refs: Vec<NativeRuntimeReceiptRef>,
    pub evidence_refs: Vec<NativeStewardEvidenceRef>,
    pub summary: Option<String>,
}

impl NativeStewardCommandReceiptLink {
    pub fn uses_reference_only_evidence(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_steward_command_term(summary))
            .unwrap_or(true)
            && self
                .receipt_refs
                .iter()
                .all(|receipt_ref| !contains_forbidden_steward_command_term(&receipt_ref.0))
            && self
                .evidence_refs
                .iter()
                .all(NativeStewardEvidenceRef::uses_reference_only_evidence)
    }

    pub fn links_command(&self, command_id: &NativeStewardCommandId) -> bool {
        &self.command_id == command_id
    }
}
