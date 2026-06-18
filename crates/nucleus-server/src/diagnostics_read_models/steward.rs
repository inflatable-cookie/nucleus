use serde::{Deserialize, Serialize};

use nucleus_native_harness::{
    NativeStewardCommandAdmission, NativeStewardCommandOutcome, NativeStewardProposal,
};

use super::helpers::{source_status, source_summary};

/// Steward diagnostics read model.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StewardDiagnosticsDto {
    pub proposals: Vec<StewardProposalDiagnosticDto>,
    pub command_admissions: Vec<StewardCommandAdmissionDiagnosticDto>,
    pub command_outcomes: Vec<StewardCommandOutcomeDiagnosticDto>,
    pub client_can_mutate: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StewardProposalDiagnosticDto {
    pub proposal_id: String,
    pub kind: String,
    pub review: String,
    pub requires_human_approval: bool,
    pub evidence_refs: Vec<String>,
    pub receipt_refs: Vec<String>,
    pub summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StewardCommandAdmissionDiagnosticDto {
    pub command_id: String,
    pub status: String,
    pub terminal: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StewardCommandOutcomeDiagnosticDto {
    pub command_id: String,
    pub status: String,
    pub terminal: bool,
    pub proposal_refs: Vec<String>,
    pub sync_assistance_refs: Vec<String>,
}

pub fn steward_diagnostics(
    proposals: &[NativeStewardProposal],
    admissions: &[NativeStewardCommandAdmission],
    outcomes: &[NativeStewardCommandOutcome],
) -> StewardDiagnosticsDto {
    let record_count = proposals.len() + admissions.len() + outcomes.len();
    StewardDiagnosticsDto {
        proposals: proposals
            .iter()
            .map(StewardProposalDiagnosticDto::from)
            .collect(),
        command_admissions: admissions
            .iter()
            .map(StewardCommandAdmissionDiagnosticDto::from)
            .collect(),
        command_outcomes: outcomes
            .iter()
            .map(StewardCommandOutcomeDiagnosticDto::from)
            .collect(),
        client_can_mutate: false,
        source_status: source_status(record_count),
        source_summary: Some(source_summary(
            record_count,
            "steward source records are not persisted yet",
            "steward diagnostics loaded from source records",
        )),
    }
}

impl From<&NativeStewardProposal> for StewardProposalDiagnosticDto {
    fn from(proposal: &NativeStewardProposal) -> Self {
        Self {
            proposal_id: proposal.id.0.clone(),
            kind: format!("{:?}", proposal.kind),
            review: format!("{:?}", proposal.review),
            requires_human_approval: proposal.requires_human_approval(),
            evidence_refs: proposal
                .evidence_refs
                .iter()
                .map(|evidence| evidence.ref_id.clone())
                .collect(),
            receipt_refs: proposal
                .receipt_refs
                .iter()
                .map(|receipt| receipt.0.clone())
                .collect(),
            summary: proposal.summary.clone(),
        }
    }
}

impl From<&NativeStewardCommandAdmission> for StewardCommandAdmissionDiagnosticDto {
    fn from(admission: &NativeStewardCommandAdmission) -> Self {
        Self {
            command_id: admission.command_id.0.clone(),
            status: format!("{:?}", admission.status),
            terminal: admission.is_rejected_or_blocked(),
        }
    }
}

impl From<&NativeStewardCommandOutcome> for StewardCommandOutcomeDiagnosticDto {
    fn from(outcome: &NativeStewardCommandOutcome) -> Self {
        Self {
            command_id: outcome.command_id.0.clone(),
            status: format!("{:?}", outcome.status),
            terminal: outcome.is_terminal(),
            proposal_refs: outcome
                .proposal_refs
                .iter()
                .map(|proposal| proposal.0.clone())
                .collect(),
            sync_assistance_refs: outcome
                .sync_assistance_refs
                .iter()
                .map(|assistance| assistance.0.clone())
                .collect(),
        }
    }
}
