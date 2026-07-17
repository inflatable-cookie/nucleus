//! Read-only DTOs for Convergence local snap runner evidence persistence.

use crate::provider_no_effects::{ConvergenceSnapNoAuthority};
use serde::{Deserialize, Serialize};

use crate::{
    ConvergenceLocalSnapRunnerEvidencePersistenceSet,
    ConvergenceLocalSnapRunnerEvidencePersistenceStatus, ConvergenceLocalSnapRunnerEvidenceStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapRunnerEvidenceControlDto {
    pub dto_id: String,
    pub persisted_count: usize,
    pub duplicate_count: usize,
    pub blocked_count: usize,
    pub reviewable_evidence_count: usize,
    pub blocker_count: usize,
    #[serde(flatten)]
    pub no_effects: ConvergenceSnapNoAuthority,
}

pub fn convergence_local_snap_runner_evidence_control_dto(
    persistence: ConvergenceLocalSnapRunnerEvidencePersistenceSet,
) -> ConvergenceLocalSnapRunnerEvidenceControlDto {
    ConvergenceLocalSnapRunnerEvidenceControlDto {
        dto_id: "convergence-local-snap-runner-evidence-control-dto".to_owned(),
        persisted_count: persistence
            .records
            .iter()
            .filter(|record| {
                record.status == ConvergenceLocalSnapRunnerEvidencePersistenceStatus::Persisted
            })
            .count(),
        duplicate_count: persistence.duplicate_evidence_ids.len(),
        blocked_count: persistence.blocked_evidence_ids.len(),
        reviewable_evidence_count: persistence
            .records
            .iter()
            .filter(|record| {
                record.evidence_status == ConvergenceLocalSnapRunnerEvidenceStatus::Reviewable
            })
            .count(),
        blocker_count: persistence
            .records
            .iter()
            .map(|record| record.blockers.len())
            .sum(),
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_runner_evidence_control_dto/tests.rs"]
mod tests;
