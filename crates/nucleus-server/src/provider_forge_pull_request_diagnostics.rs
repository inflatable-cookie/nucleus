//! Read-only diagnostics for forge pull-request descriptor and dry-run evidence.

use serde::{Deserialize, Serialize};

use crate::{
    ForgePullRequestDescriptorSet, ForgePullRequestDescriptorStatus,
    ForgePullRequestDryRunEvidenceSet, ForgePullRequestDryRunEvidenceStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgePullRequestDiagnosticsInput {
    pub descriptors: ForgePullRequestDescriptorSet,
    pub evidence: ForgePullRequestDryRunEvidenceSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgePullRequestDiagnosticsRecord {
    pub diagnostics_id: String,
    pub descriptor_count: usize,
    pub descriptor_ready_count: usize,
    pub evidence_count: usize,
    pub evidence_reviewable_count: usize,
    pub blocker_count: usize,
    pub pull_request_creation_authority_granted: bool,
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
}

pub fn forge_pull_request_diagnostics(
    input: ForgePullRequestDiagnosticsInput,
) -> ForgePullRequestDiagnosticsRecord {
    ForgePullRequestDiagnosticsRecord {
        diagnostics_id: "forge-pull-request-diagnostics".to_owned(),
        descriptor_count: input.descriptors.descriptors.len(),
        descriptor_ready_count: input
            .descriptors
            .descriptors
            .iter()
            .filter(|descriptor| descriptor.status == ForgePullRequestDescriptorStatus::Ready)
            .count(),
        evidence_count: input.evidence.evidence.len(),
        evidence_reviewable_count: input
            .evidence
            .evidence
            .iter()
            .filter(|evidence| evidence.status == ForgePullRequestDryRunEvidenceStatus::Reviewable)
            .count(),
        blocker_count: input
            .descriptors
            .descriptors
            .iter()
            .map(|descriptor| descriptor.blockers.len())
            .sum::<usize>()
            + input
                .evidence
                .evidence
                .iter()
                .map(|evidence| evidence.blockers.len())
                .sum::<usize>(),
        pull_request_creation_authority_granted: false,
        pull_request_created: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_output_retained: false,
    }
}

#[cfg(test)]
mod tests;
