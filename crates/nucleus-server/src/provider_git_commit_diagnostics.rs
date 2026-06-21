//! Read-only diagnostics for Git commit admission gates.

use serde::{Deserialize, Serialize};

use crate::{
    GitCommitAdmissionSet, GitCommitAdmissionStatus, GitCommitCommandDescriptorSet,
    GitCommitCommandDescriptorStatus, GitCommitMessageSource, GitCommitPreflightSet,
    GitCommitPreflightStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCommitDiagnosticsInput {
    pub admissions: GitCommitAdmissionSet,
    pub descriptors: GitCommitCommandDescriptorSet,
    pub preflights: GitCommitPreflightSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitCommitDiagnosticsRecord {
    pub diagnostics_id: String,
    pub admission_count: usize,
    pub admission_admitted_count: usize,
    pub descriptor_count: usize,
    pub descriptor_ready_count: usize,
    pub preflight_count: usize,
    pub preflight_ready_count: usize,
    pub operator_provided_message_count: usize,
    pub agent_suggested_message_count: usize,
    pub generated_from_diff_message_count: usize,
    pub blocker_count: usize,
    pub shell_handoff_created: bool,
    pub commit_created: bool,
    pub push_executed: bool,
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
}

pub fn git_commit_diagnostics(input: GitCommitDiagnosticsInput) -> GitCommitDiagnosticsRecord {
    GitCommitDiagnosticsRecord {
        diagnostics_id: "git-commit-diagnostics".to_owned(),
        admission_count: input.admissions.admissions.len(),
        admission_admitted_count: input
            .admissions
            .admissions
            .iter()
            .filter(|admission| admission.status == GitCommitAdmissionStatus::Admitted)
            .count(),
        descriptor_count: input.descriptors.descriptors.len(),
        descriptor_ready_count: input
            .descriptors
            .descriptors
            .iter()
            .filter(|descriptor| descriptor.status == GitCommitCommandDescriptorStatus::Ready)
            .count(),
        preflight_count: input.preflights.preflights.len(),
        preflight_ready_count: input
            .preflights
            .preflights
            .iter()
            .filter(|preflight| preflight.status == GitCommitPreflightStatus::Ready)
            .count(),
        operator_provided_message_count: count_message_source(
            &input.admissions,
            GitCommitMessageSource::OperatorProvided,
        ),
        agent_suggested_message_count: count_message_source(
            &input.admissions,
            GitCommitMessageSource::AgentSuggested,
        ),
        generated_from_diff_message_count: count_message_source(
            &input.admissions,
            GitCommitMessageSource::GeneratedFromDiff,
        ),
        blocker_count: input
            .admissions
            .admissions
            .iter()
            .map(|admission| admission.blockers.len())
            .sum::<usize>()
            + input
                .descriptors
                .descriptors
                .iter()
                .map(|descriptor| descriptor.blockers.len())
                .sum::<usize>()
            + input
                .preflights
                .preflights
                .iter()
                .map(|preflight| preflight.blockers.len())
                .sum::<usize>(),
        shell_handoff_created: false,
        commit_created: false,
        push_executed: false,
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

fn count_message_source(
    admissions: &GitCommitAdmissionSet,
    source: GitCommitMessageSource,
) -> usize {
    admissions
        .admissions
        .iter()
        .filter(|admission| admission.commit_message_source == Some(source.clone()))
        .count()
}

#[cfg(test)]
mod tests;
