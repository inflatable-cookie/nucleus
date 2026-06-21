//! Read-only diagnostics for stopped Convergence runner command adapters.

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
    pub runner_invocation_permitted: bool,
    pub provider_handoff_permitted: bool,
    pub snapshot_creation_permitted: bool,
    pub publish_permitted: bool,
    pub publication_review_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_material_retained: bool,
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
        runner_invocation_permitted: false,
        provider_handoff_permitted: false,
        snapshot_creation_permitted: false,
        publish_permitted: false,
        publication_review_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
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
