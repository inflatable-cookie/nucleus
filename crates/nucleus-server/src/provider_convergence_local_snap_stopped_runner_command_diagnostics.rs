//! Read-only diagnostics for stopped Convergence local snap runner commands.

use crate::provider_no_effects::ConvergenceSnapNoAuthority;
use serde::{Deserialize, Serialize};

use crate::{
    ConvergenceLocalSnapStoppedRunnerCommandAdapterSet,
    ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapStoppedRunnerCommandDiagnostics {
    pub diagnostics_id: String,
    pub record_count: usize,
    pub runnable_count: usize,
    pub blocked_count: usize,
    pub duplicate_count: usize,
    pub unsupported_count: usize,
    pub blocker_count: usize,
    #[serde(flatten)]
    pub no_effects: ConvergenceSnapNoAuthority,
}

pub fn convergence_local_snap_stopped_runner_command_diagnostics(
    adapter: ConvergenceLocalSnapStoppedRunnerCommandAdapterSet,
) -> ConvergenceLocalSnapStoppedRunnerCommandDiagnostics {
    ConvergenceLocalSnapStoppedRunnerCommandDiagnostics {
        diagnostics_id: "convergence-local-snap-stopped-runner-command-diagnostics".to_owned(),
        record_count: adapter.records.len(),
        runnable_count: count_status(
            &adapter,
            ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Runnable,
        ),
        blocked_count: count_status(
            &adapter,
            ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Blocked,
        ),
        duplicate_count: count_status(
            &adapter,
            ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::DuplicateNoop,
        ),
        unsupported_count: count_status(
            &adapter,
            ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Unsupported,
        ),
        blocker_count: adapter
            .records
            .iter()
            .map(|record| record.blockers.len())
            .sum(),
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}

fn count_status(
    adapter: &ConvergenceLocalSnapStoppedRunnerCommandAdapterSet,
    status: ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus,
) -> usize {
    adapter
        .records
        .iter()
        .filter(|record| record.status == status)
        .count()
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_stopped_runner_command_diagnostics/tests.rs"]
mod tests;
