//! Read-only diagnostics for stopped Convergence local snap spawn requests.

use serde::{Deserialize, Serialize};

use crate::{ConvergenceLocalSnapSpawnRequestSet, ConvergenceLocalSnapSpawnRequestStatus};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapSpawnRequestDiagnostics {
    pub diagnostics_id: String,
    pub record_count: usize,
    pub ready_count: usize,
    pub blocked_count: usize,
    pub duplicate_count: usize,
    pub unsupported_count: usize,
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

pub fn convergence_local_snap_spawn_request_diagnostics(
    request: ConvergenceLocalSnapSpawnRequestSet,
) -> ConvergenceLocalSnapSpawnRequestDiagnostics {
    ConvergenceLocalSnapSpawnRequestDiagnostics {
        diagnostics_id: "convergence-local-snap-spawn-request-diagnostics".to_owned(),
        record_count: request.records.len(),
        ready_count: count_status(&request, ConvergenceLocalSnapSpawnRequestStatus::Ready),
        blocked_count: count_status(&request, ConvergenceLocalSnapSpawnRequestStatus::Blocked),
        duplicate_count: count_status(
            &request,
            ConvergenceLocalSnapSpawnRequestStatus::DuplicateNoop,
        ),
        unsupported_count: count_status(
            &request,
            ConvergenceLocalSnapSpawnRequestStatus::Unsupported,
        ),
        blocker_count: request
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

fn count_status(
    request: &ConvergenceLocalSnapSpawnRequestSet,
    status: ConvergenceLocalSnapSpawnRequestStatus,
) -> usize {
    request
        .records
        .iter()
        .filter(|record| record.status == status)
        .count()
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_spawn_request_diagnostics/tests.rs"]
mod tests;
