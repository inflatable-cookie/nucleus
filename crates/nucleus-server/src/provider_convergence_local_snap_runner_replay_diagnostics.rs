//! Read-only diagnostics for Convergence local snap runner replay records.

use crate::provider_no_effects::{ConvergenceSnapNoAuthority};
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
    #[serde(flatten)]
    pub no_effects: ConvergenceSnapNoAuthority,
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
        no_effects: ConvergenceSnapNoAuthority::none(),
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
