use crate::personas::NativePersonaId;
use crate::tools::{NativeRuntimeReceiptRef, NativeToolActionId};

use super::records::{
    NativeStewardChangeSemantic, NativeStewardEvidenceRef, NativeStewardProposalKind,
    NativeStewardProposalReview, NativeStewardProposalTarget, NativeStewardProposedChange,
};
use super::safety::contains_forbidden_steward_term;

/// Stable steward proposal id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct NativeStewardProposalId(pub String);

/// Proposed steward hygiene change.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeStewardProposal {
    pub id: NativeStewardProposalId,
    pub persona_id: Option<NativePersonaId>,
    pub target: NativeStewardProposalTarget,
    pub kind: NativeStewardProposalKind,
    pub review: NativeStewardProposalReview,
    pub proposed_changes: Vec<NativeStewardProposedChange>,
    pub evidence_refs: Vec<NativeStewardEvidenceRef>,
    pub tool_action_id: Option<NativeToolActionId>,
    pub receipt_refs: Vec<NativeRuntimeReceiptRef>,
    pub summary: Option<String>,
}

impl NativeStewardProposal {
    pub fn is_pending_review(&self) -> bool {
        matches!(
            self.review,
            NativeStewardProposalReview::Draft
                | NativeStewardProposalReview::NeedsHumanApproval
                | NativeStewardProposalReview::NeedsPolicyApproval
        )
    }

    pub fn requires_human_approval(&self) -> bool {
        self.review == NativeStewardProposalReview::NeedsHumanApproval
            || self
                .proposed_changes
                .iter()
                .any(|change| change.semantic == NativeStewardChangeSemantic::Semantic)
    }

    pub fn uses_reference_only_evidence(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_steward_term(summary))
            .unwrap_or(true)
            && self
                .proposed_changes
                .iter()
                .all(NativeStewardProposedChange::uses_reference_only_evidence)
            && self
                .evidence_refs
                .iter()
                .all(NativeStewardEvidenceRef::uses_reference_only_evidence)
            && self
                .receipt_refs
                .iter()
                .all(|receipt_ref| !contains_forbidden_steward_term(&receipt_ref.0))
    }

    pub fn has_applied_mutation_state(&self) -> bool {
        false
    }
}
