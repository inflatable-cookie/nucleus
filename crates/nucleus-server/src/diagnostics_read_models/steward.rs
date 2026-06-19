use serde::{Deserialize, Serialize};

use nucleus_native_harness::{
    NativeStewardCommandAdmission, NativeStewardCommandOutcome, NativeStewardProposal,
    NativeStewardSyncDecisionRecord,
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

/// Steward SCM sync diagnostics read model.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StewardSyncDiagnosticsDto {
    pub decisions: Vec<StewardSyncDecisionDiagnosticDto>,
    pub client_can_mutate: bool,
    pub client_can_mutate_provider: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StewardSyncDecisionDiagnosticDto {
    pub decision_id: String,
    pub assistance_id: Option<String>,
    pub kind: String,
    pub confidence: String,
    pub requested_next_action: String,
    pub blocked_reasons: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub provider_mutation_allowed: bool,
    pub advisory_only: bool,
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

pub fn steward_sync_diagnostics(
    decisions: &[NativeStewardSyncDecisionRecord],
) -> StewardSyncDiagnosticsDto {
    let record_count = decisions.len();
    StewardSyncDiagnosticsDto {
        decisions: decisions
            .iter()
            .map(StewardSyncDecisionDiagnosticDto::from)
            .collect(),
        client_can_mutate: false,
        client_can_mutate_provider: false,
        source_status: source_status(record_count),
        source_summary: Some(source_summary(
            record_count,
            "steward sync decisions are empty",
            "steward sync diagnostics loaded from decision records",
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

impl From<&NativeStewardSyncDecisionRecord> for StewardSyncDecisionDiagnosticDto {
    fn from(decision: &NativeStewardSyncDecisionRecord) -> Self {
        Self {
            decision_id: decision.id.0.clone(),
            assistance_id: decision
                .assistance_id
                .as_ref()
                .map(|assistance| assistance.0.clone()),
            kind: format!("{:?}", decision.kind),
            confidence: format!("{:?}", decision.confidence),
            requested_next_action: format!("{:?}", decision.requested_next_action),
            blocked_reasons: decision.blocked_reasons.clone(),
            evidence_refs: decision
                .evidence_refs
                .iter()
                .map(|evidence| evidence.ref_id.clone())
                .collect(),
            provider_mutation_allowed: decision.provider_mutation_allowed,
            advisory_only: decision.is_advisory_only(),
        }
    }
}
