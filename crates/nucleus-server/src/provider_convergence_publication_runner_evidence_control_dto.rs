//! Read-only DTOs for Convergence runner evidence persistence.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergencePublicationRunnerEvidencePersistenceSet,
    ConvergencePublicationRunnerEvidencePersistenceStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergencePublicationRunnerEvidenceControlDto {
    pub dto_id: String,
    pub persisted_count: usize,
    pub duplicate_count: usize,
    pub blocked_count: usize,
    pub reviewable_evidence_count: usize,
    pub blocker_count: usize,
    pub runner_invocation_permitted: bool,
    pub provider_handoff_permitted: bool,
    pub snapshot_creation_permitted: bool,
    pub publish_permitted: bool,
    pub publication_review_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_material_retained: bool,
}

pub fn convergence_publication_runner_evidence_control_dto(
    persistence: ConvergencePublicationRunnerEvidencePersistenceSet,
) -> ConvergencePublicationRunnerEvidenceControlDto {
    ConvergencePublicationRunnerEvidenceControlDto {
        dto_id: "convergence-publication-runner-evidence-control-dto".to_owned(),
        persisted_count: persistence
            .records
            .iter()
            .filter(|record| {
                record.status == ConvergencePublicationRunnerEvidencePersistenceStatus::Persisted
            })
            .count(),
        duplicate_count: persistence.duplicate_evidence_ids.len(),
        blocked_count: persistence.blocked_evidence_ids.len(),
        reviewable_evidence_count: persistence
            .records
            .iter()
            .filter(|record| {
                record.evidence_status
                    == crate::ConvergencePublicationRunnerEvidenceStatus::Reviewable
            })
            .count(),
        blocker_count: persistence
            .records
            .iter()
            .map(|record| record.blockers.len())
            .sum(),
        runner_invocation_permitted: false,
        provider_handoff_permitted: false,
        snapshot_creation_permitted: false,
        publish_permitted: false,
        publication_review_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}

#[cfg(test)]
#[path = "provider_convergence_publication_runner_evidence_control_dto/tests.rs"]
mod tests;
