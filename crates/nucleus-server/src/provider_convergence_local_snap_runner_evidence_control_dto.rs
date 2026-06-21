//! Read-only DTOs for Convergence local snap runner evidence persistence.

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
    pub command_spawn_permitted: bool,
    pub local_snap_creation_permitted: bool,
    pub object_upload_permitted: bool,
    pub publication_permitted: bool,
    pub lane_sync_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_material_retained: bool,
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
        command_spawn_permitted: false,
        local_snap_creation_permitted: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_runner_evidence_control_dto/tests.rs"]
mod tests;
