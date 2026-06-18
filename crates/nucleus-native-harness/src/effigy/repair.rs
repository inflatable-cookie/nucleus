use super::integration::NativeEffigyEvidenceRef;
use super::safety::contains_forbidden_effigy_term;
use crate::steward::{
    NativeStewardEvidenceRef, NativeStewardEvidenceSource, NativeStewardProposal,
    NativeStewardProposalId, NativeStewardProposalKind, NativeStewardProposalReview,
    NativeStewardProposalTarget,
};

/// Sanitized repair hint derived from Effigy evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeEffigyRepairHint {
    pub kind: NativeEffigyRepairHintKind,
    pub evidence_refs: Vec<NativeEffigyEvidenceRef>,
    pub summary: Option<String>,
}

impl NativeEffigyRepairHint {
    pub fn uses_sanitized_refs(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_effigy_term(summary))
            .unwrap_or(true)
            && self
                .evidence_refs
                .iter()
                .all(|evidence_ref| !contains_forbidden_effigy_term(&evidence_ref.0))
    }
}

/// Repair hint category.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeEffigyRepairHintKind {
    MissingManifest,
    MissingSelector,
    DoctorWarning,
    DoctorError,
    PlanUnavailable,
    PolicyBlocked,
    Custom(String),
}

/// Synthesis of Effigy findings into repair hints and steward proposals.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeEffigyRepairSynthesis {
    pub source: NativeEffigyRepairSource,
    pub status: NativeEffigyRepairSynthesisStatus,
    pub repair_hints: Vec<NativeEffigyRepairHint>,
    pub evidence_refs: Vec<NativeEffigyEvidenceRef>,
    pub summary: Option<String>,
}

impl NativeEffigyRepairSynthesis {
    pub fn from_repair_hints(
        source: NativeEffigyRepairSource,
        repair_hints: Vec<NativeEffigyRepairHint>,
    ) -> Self {
        let status = if repair_hints.is_empty() {
            NativeEffigyRepairSynthesisStatus::NoRepairNeeded
        } else {
            NativeEffigyRepairSynthesisStatus::ProposalReady
        };
        Self {
            source,
            status,
            repair_hints,
            evidence_refs: Vec::new(),
            summary: None,
        }
    }

    pub fn to_steward_proposal(
        &self,
        id: NativeStewardProposalId,
        target: NativeStewardProposalTarget,
    ) -> Option<NativeStewardProposal> {
        if self.status != NativeEffigyRepairSynthesisStatus::ProposalReady
            || !self.uses_sanitized_refs()
        {
            return None;
        }

        Some(NativeStewardProposal {
            id,
            persona_id: None,
            target,
            kind: NativeStewardProposalKind::ProjectOrganizationHint,
            review: NativeStewardProposalReview::NeedsHumanApproval,
            proposed_changes: Vec::new(),
            evidence_refs: self
                .evidence_refs
                .iter()
                .map(|evidence_ref| NativeStewardEvidenceRef {
                    source: NativeStewardEvidenceSource::Effigy,
                    ref_id: evidence_ref.0.clone(),
                })
                .collect(),
            tool_action_id: None,
            receipt_refs: Vec::new(),
            summary: self.summary.clone(),
        })
    }

    pub fn mutates_manifest_or_scripts(&self) -> bool {
        false
    }

    pub fn uses_sanitized_refs(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_effigy_term(summary))
            .unwrap_or(true)
            && self
                .repair_hints
                .iter()
                .all(NativeEffigyRepairHint::uses_sanitized_refs)
            && self
                .evidence_refs
                .iter()
                .all(|evidence_ref| !contains_forbidden_effigy_term(&evidence_ref.0))
    }
}

/// Effigy inspection source for repair synthesis.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeEffigyRepairSource {
    SelectorRefresh,
    Doctor,
    TestPlan,
    Custom(String),
}

/// Repair synthesis state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeEffigyRepairSynthesisStatus {
    NoRepairNeeded,
    ProposalReady,
    Blocked(String),
    Unsupported(String),
    Unknown,
}
