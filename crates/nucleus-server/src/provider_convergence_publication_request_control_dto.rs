//! Read-only control DTOs for Convergence-like request persistence.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergencePublicationRequestPersistenceSet, ConvergencePublicationRequestPersistenceStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergencePublicationRequestControlDto {
    pub dto_id: String,
    pub persisted_count: usize,
    pub duplicate_count: usize,
    pub blocked_count: usize,
    pub stopped_request_count: usize,
    pub blocker_count: usize,
    pub provider_handoff_permitted: bool,
    pub snapshot_creation_permitted: bool,
    pub publish_permitted: bool,
    pub publication_review_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_material_retained: bool,
}

pub fn convergence_publication_request_control_dto(
    persistence: ConvergencePublicationRequestPersistenceSet,
) -> ConvergencePublicationRequestControlDto {
    ConvergencePublicationRequestControlDto {
        dto_id: "convergence-publication-request-control-dto".to_owned(),
        persisted_count: persistence
            .records
            .iter()
            .filter(|record| {
                record.status == ConvergencePublicationRequestPersistenceStatus::Persisted
            })
            .count(),
        duplicate_count: persistence.duplicate_idempotency_keys.len(),
        blocked_count: persistence.blocked_request_ids.len(),
        stopped_request_count: persistence
            .records
            .iter()
            .filter(|record| {
                record.request_status == crate::ConvergencePublicationStoppedRequestStatus::Stopped
            })
            .count(),
        blocker_count: persistence
            .records
            .iter()
            .map(|record| record.blockers.len())
            .sum(),
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
#[path = "provider_convergence_publication_request_control_dto/tests.rs"]
mod tests;
