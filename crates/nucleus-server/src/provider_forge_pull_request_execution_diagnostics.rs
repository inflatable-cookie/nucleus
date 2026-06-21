//! Read-only diagnostics for forge pull-request execution admissions.

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
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
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
        pull_request_created: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_output_retained: false,
    }
}

#[cfg(test)]
mod tests;
