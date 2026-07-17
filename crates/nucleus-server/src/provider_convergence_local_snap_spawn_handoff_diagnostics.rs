//! Read-only diagnostics for stopped Convergence local snap spawn handoff.

use crate::provider_no_effects::{ConvergenceSnapNoAuthority};
use serde::{Deserialize, Serialize};

use crate::{ConvergenceLocalSnapSpawnHandoffSet, ConvergenceLocalSnapSpawnHandoffStatus};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapSpawnHandoffDiagnostics {
    pub diagnostics_id: String,
    pub record_count: usize,
    pub ready_count: usize,
    pub blocked_count: usize,
    pub duplicate_count: usize,
    pub unsupported_count: usize,
    pub blocker_count: usize,
    pub process_runner_invocation_permitted: bool,
    #[serde(flatten)]
    pub no_effects: ConvergenceSnapNoAuthority,
}

pub fn convergence_local_snap_spawn_handoff_diagnostics(
    handoff: ConvergenceLocalSnapSpawnHandoffSet,
) -> ConvergenceLocalSnapSpawnHandoffDiagnostics {
    ConvergenceLocalSnapSpawnHandoffDiagnostics {
        diagnostics_id: "convergence-local-snap-spawn-handoff-diagnostics".to_owned(),
        record_count: handoff.records.len(),
        ready_count: count_status(&handoff, ConvergenceLocalSnapSpawnHandoffStatus::Ready),
        blocked_count: count_status(&handoff, ConvergenceLocalSnapSpawnHandoffStatus::Blocked),
        duplicate_count: count_status(
            &handoff,
            ConvergenceLocalSnapSpawnHandoffStatus::DuplicateNoop,
        ),
        unsupported_count: count_status(
            &handoff,
            ConvergenceLocalSnapSpawnHandoffStatus::Unsupported,
        ),
        blocker_count: handoff
            .records
            .iter()
            .map(|record| record.blockers.len())
            .sum(),
        process_runner_invocation_permitted: false,
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}

fn count_status(
    handoff: &ConvergenceLocalSnapSpawnHandoffSet,
    status: ConvergenceLocalSnapSpawnHandoffStatus,
) -> usize {
    handoff
        .records
        .iter()
        .filter(|record| record.status == status)
        .count()
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_spawn_handoff_diagnostics/tests.rs"]
mod tests;
