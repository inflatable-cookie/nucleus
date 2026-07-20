//! Read-only diagnostics for forge pull-request execution admissions.

use crate::provider_no_effects::ForgeScmNoEffects;
use serde::{Deserialize, Serialize};

use crate::{
    ForgePullRequestExecutionAdmissionSet, ForgePullRequestExecutionAdmissionStatus,
    ForgePullRequestExecutionPreflightSet, ForgePullRequestExecutionPreflightStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgePullRequestExecutionDiagnosticsInput {
    pub admissions: ForgePullRequestExecutionAdmissionSet,
    pub preflights: ForgePullRequestExecutionPreflightSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgePullRequestExecutionDiagnosticsRecord {
    pub diagnostics_id: String,
    pub admission_count: usize,
    pub admission_admitted_count: usize,
    pub preflight_count: usize,
    pub preflight_ready_count: usize,
    pub blocker_count: usize,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

pub fn forge_pull_request_execution_diagnostics(
    input: ForgePullRequestExecutionDiagnosticsInput,
) -> ForgePullRequestExecutionDiagnosticsRecord {
    ForgePullRequestExecutionDiagnosticsRecord {
        diagnostics_id: "forge-pull-request-execution-diagnostics".to_owned(),
        admission_count: input.admissions.admissions.len(),
        admission_admitted_count: input
            .admissions
            .admissions
            .iter()
            .filter(|admission| {
                admission.status == ForgePullRequestExecutionAdmissionStatus::Admitted
            })
            .count(),
        preflight_count: input.preflights.preflights.len(),
        preflight_ready_count: input
            .preflights
            .preflights
            .iter()
            .filter(|preflight| preflight.status == ForgePullRequestExecutionPreflightStatus::Ready)
            .count(),
        blocker_count: input
            .admissions
            .admissions
            .iter()
            .map(|admission| admission.blockers.len())
            .sum::<usize>()
            + input
                .preflights
                .preflights
                .iter()
                .map(|preflight| preflight.blockers.len())
                .sum::<usize>(),
        no_effects: ForgeScmNoEffects::none(),
    }
}

#[cfg(test)]
mod tests;
