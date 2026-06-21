//! Read-only diagnostics for Convergence runner replay records.

use serde::{Deserialize, Serialize};

use crate::{ConvergenceRunnerReplayRecordSet, ConvergenceRunnerReplayStatus};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceRunnerReplayDiagnostics {
    pub diagnostics_id: String,
    pub record_count: usize,
    pub replayed_count: usize,
    pub duplicate_count: usize,
    pub blocked_count: usize,
    pub unsupported_count: usize,
    pub effect_family_count: usize,
    pub blocker_count: usize,
    pub backend_effect_permitted: bool,
    pub object_upload_permitted: bool,
    pub publication_permitted: bool,
    pub lane_sync_permitted: bool,
    pub bundle_permitted: bool,
    pub approval_permitted: bool,
    pub promotion_permitted: bool,
    pub release_permitted: bool,
    pub resolution_publication_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_material_retained: bool,
}

pub fn convergence_runner_replay_diagnostics(
    replay: ConvergenceRunnerReplayRecordSet,
) -> ConvergenceRunnerReplayDiagnostics {
    ConvergenceRunnerReplayDiagnostics {
        diagnostics_id: "convergence-runner-replay-diagnostics".to_owned(),
        record_count: replay.records.len(),
        replayed_count: count_status(&replay, ConvergenceRunnerReplayStatus::Replayed),
        duplicate_count: count_status(&replay, ConvergenceRunnerReplayStatus::DuplicateNoop),
        blocked_count: count_status(&replay, ConvergenceRunnerReplayStatus::Blocked),
        unsupported_count: count_status(&replay, ConvergenceRunnerReplayStatus::Unsupported),
        effect_family_count: replay
            .records
            .iter()
            .map(|record| record.effect_families.len())
            .sum(),
        blocker_count: replay
            .records
            .iter()
            .map(|record| record.blockers.len())
            .sum(),
        backend_effect_permitted: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        bundle_permitted: false,
        approval_permitted: false,
        promotion_permitted: false,
        release_permitted: false,
        resolution_publication_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}

fn count_status(
    replay: &ConvergenceRunnerReplayRecordSet,
    status: ConvergenceRunnerReplayStatus,
) -> usize {
    replay
        .records
        .iter()
        .filter(|record| record.status == status)
        .count()
}

#[cfg(test)]
#[path = "provider_convergence_runner_replay_diagnostics/tests.rs"]
mod tests;
