//! Read-only diagnostics for Convergence local snap execution preflight.

use crate::provider_no_effects::{ConvergenceSnapNoAuthority};
use serde::{Deserialize, Serialize};

use crate::{
    ConvergenceLocalSnapExecutionPreflightSet, ConvergenceLocalSnapExecutionPreflightStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapExecutionPreflightDiagnostics {
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

pub fn convergence_local_snap_execution_preflight_diagnostics(
    preflight: ConvergenceLocalSnapExecutionPreflightSet,
) -> ConvergenceLocalSnapExecutionPreflightDiagnostics {
    ConvergenceLocalSnapExecutionPreflightDiagnostics {
        diagnostics_id: "convergence-local-snap-execution-preflight-diagnostics".to_owned(),
        record_count: preflight.records.len(),
        ready_count: count_status(
            &preflight,
            ConvergenceLocalSnapExecutionPreflightStatus::Ready,
        ),
        blocked_count: count_status(
            &preflight,
            ConvergenceLocalSnapExecutionPreflightStatus::Blocked,
        ),
        duplicate_count: count_status(
            &preflight,
            ConvergenceLocalSnapExecutionPreflightStatus::DuplicateNoop,
        ),
        unsupported_count: count_status(
            &preflight,
            ConvergenceLocalSnapExecutionPreflightStatus::Unsupported,
        ),
        blocker_count: preflight
            .records
            .iter()
            .map(|record| record.blockers.len())
            .sum(),
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}

fn count_status(
    preflight: &ConvergenceLocalSnapExecutionPreflightSet,
    status: ConvergenceLocalSnapExecutionPreflightStatus,
) -> usize {
    preflight
        .records
        .iter()
        .filter(|record| record.status == status)
        .count()
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_execution_preflight_diagnostics/tests.rs"]
mod tests;
