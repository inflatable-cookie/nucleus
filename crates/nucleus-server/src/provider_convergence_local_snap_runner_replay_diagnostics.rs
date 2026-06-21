//! Read-only diagnostics for Convergence local snap runner replay records.

use serde::{Deserialize, Serialize};

use crate::{ConvergenceLocalSnapRunnerReplayRecordSet, ConvergenceLocalSnapRunnerReplayStatus};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapRunnerReplayDiagnostics {
    pub diagnostics_id: String,
    pub record_count: usize,
    pub replayed_count: usize,
    pub duplicate_count: usize,
    pub blocked_count: usize,
    pub unsupported_count: usize,
    pub effect_family_count: usize,
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

pub fn convergence_local_snap_runner_replay_diagnostics(
    replay: ConvergenceLocalSnapRunnerReplayRecordSet,
) -> ConvergenceLocalSnapRunnerReplayDiagnostics {
    ConvergenceLocalSnapRunnerReplayDiagnostics {
        diagnostics_id: "convergence-local-snap-runner-replay-diagnostics".to_owned(),
        record_count: replay.records.len(),
        replayed_count: count_status(&replay, ConvergenceLocalSnapRunnerReplayStatus::Replayed),
        duplicate_count: count_status(
            &replay,
            ConvergenceLocalSnapRunnerReplayStatus::DuplicateNoop,
        ),
        blocked_count: count_status(&replay, ConvergenceLocalSnapRunnerReplayStatus::Blocked),
        unsupported_count: count_status(
            &replay,
            ConvergenceLocalSnapRunnerReplayStatus::Unsupported,
        ),
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
    replay: &ConvergenceLocalSnapRunnerReplayRecordSet,
    status: ConvergenceLocalSnapRunnerReplayStatus,
) -> usize {
    replay
        .records
        .iter()
        .filter(|record| record.status == status)
        .count()
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_runner_replay_diagnostics/tests.rs"]
mod tests;
