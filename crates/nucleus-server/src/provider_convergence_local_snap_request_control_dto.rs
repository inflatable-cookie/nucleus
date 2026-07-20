//! Read-only control DTOs for Convergence local snap request persistence.

use crate::provider_no_effects::ConvergenceSnapNoAuthority;
use serde::{Deserialize, Serialize};

use crate::{
    ConvergenceLocalSnapRequestPersistenceSet, ConvergenceLocalSnapRequestPersistenceStatus,
    ConvergenceLocalSnapStoppedRequestStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapRequestControlDto {
    pub dto_id: String,
    pub persisted_count: usize,
    pub duplicate_count: usize,
    pub blocked_count: usize,
    pub stopped_request_count: usize,
    pub blocker_count: usize,
    #[serde(flatten)]
    pub no_effects: ConvergenceSnapNoAuthority,
}

pub fn convergence_local_snap_request_control_dto(
    persistence: ConvergenceLocalSnapRequestPersistenceSet,
) -> ConvergenceLocalSnapRequestControlDto {
    ConvergenceLocalSnapRequestControlDto {
        dto_id: "convergence-local-snap-request-control-dto".to_owned(),
        persisted_count: persistence
            .records
            .iter()
            .filter(|record| {
                record.status == ConvergenceLocalSnapRequestPersistenceStatus::Persisted
            })
            .count(),
        duplicate_count: persistence.duplicate_idempotency_keys.len(),
        blocked_count: persistence.blocked_request_ids.len(),
        stopped_request_count: persistence
            .records
            .iter()
            .filter(|record| {
                record.request_status == ConvergenceLocalSnapStoppedRequestStatus::Stopped
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
#[path = "provider_convergence_local_snap_request_control_dto/tests.rs"]
mod tests;
