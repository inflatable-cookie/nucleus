//! Read-only diagnostics for stopped Convergence local snap spawn requests.

use crate::provider_no_effects::{ConvergenceSnapNoAuthority};
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
    #[serde(flatten)]
    pub no_effects: ConvergenceSnapNoAuthority,
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
        no_effects: ConvergenceSnapNoAuthority::none(),
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
