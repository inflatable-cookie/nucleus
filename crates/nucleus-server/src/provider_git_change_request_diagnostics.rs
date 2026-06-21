//! Read-only diagnostics for Git change-request execution gates.

use serde::{Deserialize, Serialize};

use crate::{
    GitChangeRequestCommandDescriptorSet, GitChangeRequestCommandDescriptorStatus,
    GitChangeRequestCommandRequestSet, GitChangeRequestCommandRequestStatus,
    GitChangeRequestExecutionAuthoritySet, GitChangeRequestExecutionAuthorityStatus,
    GitChangeRequestPreflightSet, GitChangeRequestPreflightStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitChangeRequestDiagnosticsInput {
    pub authorities: GitChangeRequestExecutionAuthoritySet,
    pub descriptors: GitChangeRequestCommandDescriptorSet,
    pub requests: GitChangeRequestCommandRequestSet,
    pub preflights: GitChangeRequestPreflightSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitChangeRequestDiagnosticsRecord {
    pub diagnostics_id: String,
    pub authority_count: usize,
    pub authority_ready_count: usize,
    pub descriptor_count: usize,
    pub descriptor_ready_count: usize,
    pub request_count: usize,
    pub request_admitted_count: usize,
    pub preflight_count: usize,
    pub preflight_ready_count: usize,
    pub blocker_count: usize,
    pub branch_authority_requested_count: usize,
    pub commit_authority_requested_count: usize,
    pub push_authority_requested_count: usize,
    pub pull_request_authority_requested_count: usize,
    pub command_execution_enabled: bool,
    pub shell_command_created: bool,
    pub forge_request_created: bool,
    pub raw_output_retained: bool,
}

pub fn git_change_request_diagnostics(
    input: GitChangeRequestDiagnosticsInput,
) -> GitChangeRequestDiagnosticsRecord {
    GitChangeRequestDiagnosticsRecord {
        diagnostics_id: "git-change-request-diagnostics".to_owned(),
        authority_count: input.authorities.authorities.len(),
        authority_ready_count: input
            .authorities
            .authorities
            .iter()
            .filter(|authority| authority.status == GitChangeRequestExecutionAuthorityStatus::Ready)
            .count(),
        descriptor_count: input.descriptors.descriptors.len(),
        descriptor_ready_count: input
            .descriptors
            .descriptors
            .iter()
            .filter(|descriptor| {
                descriptor.status == GitChangeRequestCommandDescriptorStatus::Ready
            })
            .count(),
        request_count: input.requests.requests.len(),
        request_admitted_count: input
            .requests
            .requests
            .iter()
            .filter(|request| request.status == GitChangeRequestCommandRequestStatus::Admitted)
            .count(),
        preflight_count: input.preflights.preflights.len(),
        preflight_ready_count: input
            .preflights
            .preflights
            .iter()
            .filter(|preflight| preflight.status == GitChangeRequestPreflightStatus::Ready)
            .count(),
        blocker_count: input
            .authorities
            .authorities
            .iter()
            .map(|authority| authority.blockers.len())
            .sum::<usize>()
            + input
                .descriptors
                .descriptors
                .iter()
                .map(|descriptor| descriptor.blockers.len())
                .sum::<usize>()
            + input
                .requests
                .requests
                .iter()
                .map(|request| request.blockers.len())
                .sum::<usize>()
            + input
                .preflights
                .preflights
                .iter()
                .map(|preflight| preflight.blockers.len())
                .sum::<usize>(),
        branch_authority_requested_count: input
            .authorities
            .authorities
            .iter()
            .filter(|authority| authority.branch_authority_requested)
            .count(),
        commit_authority_requested_count: input
            .authorities
            .authorities
            .iter()
            .filter(|authority| authority.commit_authority_requested)
            .count(),
        push_authority_requested_count: input
            .authorities
            .authorities
            .iter()
            .filter(|authority| authority.push_authority_requested)
            .count(),
        pull_request_authority_requested_count: input
            .authorities
            .authorities
            .iter()
            .filter(|authority| authority.pull_request_authority_requested)
            .count(),
        command_execution_enabled: false,
        shell_command_created: false,
        forge_request_created: false,
        raw_output_retained: false,
    }
}

#[cfg(test)]
mod tests;
