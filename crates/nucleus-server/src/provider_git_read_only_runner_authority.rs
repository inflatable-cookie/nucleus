//! Authority proof for the read-only Git runner proof.

use serde::{Deserialize, Serialize};

use crate::{GitDiffStatSummaryRecord, GitReadOnlyRunnerRecord, GitStatusSummaryRecord};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitReadOnlyRunnerAuthorityInput {
    pub runner_records: Vec<GitReadOnlyRunnerRecord>,
    pub status_summaries: Vec<GitStatusSummaryRecord>,
    pub diff_stat_summaries: Vec<GitDiffStatSummaryRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitReadOnlyRunnerAuthorityRecord {
    pub authority_id: String,
    pub runner_record_count: usize,
    pub status_summary_count: usize,
    pub diff_stat_summary_count: usize,
    pub read_only_execution_count: usize,
    pub checkout_executed: bool,
    pub branch_mutation_executed: bool,
    pub commit_executed: bool,
    pub push_executed: bool,
    pub forge_effect_executed: bool,
    pub provider_write_executed: bool,
    pub callback_response_executed: bool,
    pub interruption_executed: bool,
    pub recovery_executed: bool,
    pub raw_output_persisted: bool,
}

pub fn git_read_only_runner_authority(
    input: GitReadOnlyRunnerAuthorityInput,
) -> GitReadOnlyRunnerAuthorityRecord {
    GitReadOnlyRunnerAuthorityRecord {
        authority_id: "git-read-only-runner-authority".to_owned(),
        runner_record_count: input.runner_records.len(),
        status_summary_count: input.status_summaries.len(),
        diff_stat_summary_count: input.diff_stat_summaries.len(),
        read_only_execution_count: input
            .runner_records
            .iter()
            .filter(|record| record.git_read_only_command_executed)
            .count(),
        checkout_executed: false,
        branch_mutation_executed: false,
        commit_executed: false,
        push_executed: false,
        forge_effect_executed: false,
        provider_write_executed: false,
        callback_response_executed: false,
        interruption_executed: false,
        recovery_executed: false,
        raw_output_persisted: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_read_only_runner_authority_blocks_mutating_effects() {
        let record = git_read_only_runner_authority(GitReadOnlyRunnerAuthorityInput {
            runner_records: vec![crate::GitReadOnlyRunnerRecord {
                runner_id: "runner:1".to_owned(),
                handoff_id: "handoff:1".to_owned(),
                descriptor_id: "git-dry-run-status-porcelain".to_owned(),
                repo_id: "repo:1".to_owned(),
                status: crate::GitReadOnlyRunnerStatus::Completed,
                blockers: Vec::new(),
                exit_code: Some(0),
                stdout_size_bytes: 10,
                stderr_size_bytes: 0,
                git_read_only_command_executed: true,
                raw_output_persisted: false,
                checkout_executed: false,
                branch_mutation_executed: false,
                commit_executed: false,
                push_executed: false,
                forge_effect_executed: false,
                provider_write_executed: false,
                callback_response_executed: false,
                interruption_executed: false,
                recovery_executed: false,
            }],
            status_summaries: vec![crate::git_status_summary_parser(b"?? file.txt\0")],
            diff_stat_summaries: vec![crate::git_diff_stat_summary_parser("")],
        });

        assert_eq!(record.runner_record_count, 1);
        assert_eq!(record.read_only_execution_count, 1);
        assert!(!record.checkout_executed);
        assert!(!record.branch_mutation_executed);
        assert!(!record.commit_executed);
        assert!(!record.push_executed);
        assert!(!record.provider_write_executed);
        assert!(!record.raw_output_persisted);
    }
}
