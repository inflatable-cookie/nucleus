//! Read-only diagnostics for stopped Convergence runner command adapters.

use crate::provider_no_effects::{ConvergenceRunnerNoAuthority};
use serde::{Deserialize, Serialize};

use crate::{
    ConvergenceStoppedRunnerCommandAdapterSet, ConvergenceStoppedRunnerCommandAdapterStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceStoppedRunnerCommandDiagnostics {
    pub diagnostics_id: String,
    pub record_count: usize,
    pub runnable_count: usize,
    pub blocked_count: usize,
    pub duplicate_count: usize,
    pub unsupported_count: usize,
    pub blocker_count: usize,
    #[serde(flatten)]
    pub no_effects: ConvergenceRunnerNoAuthority,
}

pub fn convergence_stopped_runner_command_diagnostics(
    adapter: ConvergenceStoppedRunnerCommandAdapterSet,
) -> ConvergenceStoppedRunnerCommandDiagnostics {
    ConvergenceStoppedRunnerCommandDiagnostics {
        diagnostics_id: "convergence-stopped-runner-command-diagnostics".to_owned(),
        record_count: adapter.records.len(),
        runnable_count: count_status(
            &adapter,
            ConvergenceStoppedRunnerCommandAdapterStatus::Runnable,
        ),
        blocked_count: count_status(
            &adapter,
            ConvergenceStoppedRunnerCommandAdapterStatus::Blocked,
        ),
        duplicate_count: count_status(
            &adapter,
            ConvergenceStoppedRunnerCommandAdapterStatus::DuplicateNoop,
        ),
        unsupported_count: count_status(
            &adapter,
            ConvergenceStoppedRunnerCommandAdapterStatus::Unsupported,
        ),
        blocker_count: adapter
            .records
            .iter()
            .map(|record| record.blockers.len())
            .sum(),
        no_effects: ConvergenceRunnerNoAuthority::none(),
    }
}

fn count_status(
    adapter: &ConvergenceStoppedRunnerCommandAdapterSet,
    status: ConvergenceStoppedRunnerCommandAdapterStatus,
) -> usize {
    adapter
        .records
        .iter()
        .filter(|record| record.status == status)
        .count()
}

#[cfg(test)]
#[path = "provider_convergence_stopped_runner_command_diagnostics/tests.rs"]
mod tests;
