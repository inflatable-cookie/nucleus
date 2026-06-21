//! Read-only diagnostics for stopped Convergence local snap runner commands.

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
    pub command_spawn_permitted: bool,
    pub local_snap_creation_permitted: bool,
    pub object_upload_permitted: bool,
    pub publication_permitted: bool,
    pub lane_sync_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_material_retained: bool,
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
