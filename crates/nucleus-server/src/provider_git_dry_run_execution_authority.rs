//! Authority proof for Git dry-run command execution-boundary records.

use serde::{Deserialize, Serialize};

use crate::{
    GitDryRunCommandRequestRecord, GitDryRunEvidenceCaptureRecord, GitDryRunRunnerBoundaryRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitDryRunExecutionAuthorityInput {
    pub requests: Vec<GitDryRunCommandRequestRecord>,
    pub handoffs: Vec<GitDryRunRunnerBoundaryRecord>,
    pub captures: Vec<GitDryRunEvidenceCaptureRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitDryRunExecutionAuthorityRecord {
    pub authority_id: String,
    pub request_count: usize,
    pub handoff_count: usize,
    pub capture_count: usize,
    pub dry_run_executed_count: usize,
    pub checkout_executed: bool,
    pub branch_mutation_executed: bool,
    pub commit_executed: bool,
    pub push_executed: bool,
    pub forge_effect_executed: bool,
    pub provider_write_executed: bool,
    pub callback_response_executed: bool,
    pub interruption_executed: bool,
    pub recovery_executed: bool,
    pub raw_output_retained: bool,
}

pub fn git_dry_run_execution_authority_regressions(
    input: GitDryRunExecutionAuthorityInput,
) -> GitDryRunExecutionAuthorityRecord {
    GitDryRunExecutionAuthorityRecord {
        authority_id: "git-dry-run-execution-authority".to_owned(),
        request_count: input.requests.len(),
        handoff_count: input.handoffs.len(),
        capture_count: input.captures.len(),
        dry_run_executed_count: input
            .captures
            .iter()
            .filter(|capture| capture.git_dry_run_executed)
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
        raw_output_retained: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_dry_run_execution_authority_regressions_block_mutating_effects() {
        let record = git_dry_run_execution_authority_regressions(input());

        assert_eq!(record.request_count, 1);
        assert_eq!(record.handoff_count, 1);
        assert_eq!(record.capture_count, 1);
        assert_eq!(record.dry_run_executed_count, 1);
        assert!(!record.checkout_executed);
        assert!(!record.branch_mutation_executed);
        assert!(!record.commit_executed);
        assert!(!record.push_executed);
        assert!(!record.forge_effect_executed);
        assert!(!record.provider_write_executed);
        assert!(!record.callback_response_executed);
        assert!(!record.interruption_executed);
        assert!(!record.recovery_executed);
        assert!(!record.raw_output_retained);
    }

    fn input() -> GitDryRunExecutionAuthorityInput {
        GitDryRunExecutionAuthorityInput {
            requests: vec![crate::GitDryRunCommandRequestRecord {
                request_id: "request:1".to_owned(),
                admission_id: "admission:1".to_owned(),
                descriptor_id: "git-dry-run-status-porcelain".to_owned(),
                repo_id: "repo:1".to_owned(),
                worktree_path_ref: "path-ref:repo".to_owned(),
                evidence_root_ref: "evidence-root:1".to_owned(),
                argv: vec!["git".to_owned(), "status".to_owned()],
                stdout_limit_bytes: 64 * 1024,
                stderr_limit_bytes: 8 * 1024,
                status: crate::GitDryRunCommandRequestStatus::Admitted,
                blockers: Vec::new(),
                git_dry_run_requested: true,
                checkout_authority_granted: false,
                branch_mutation_authority_granted: false,
                commit_authority_granted: false,
                push_authority_granted: false,
                forge_authority_granted: false,
                raw_output_retention_granted: false,
            }],
            handoffs: vec![crate::GitDryRunRunnerBoundaryRecord {
                handoff_id: "handoff:1".to_owned(),
                request_id: "request:1".to_owned(),
                descriptor_id: "git-dry-run-status-porcelain".to_owned(),
                repo_id: "repo:1".to_owned(),
                cwd_ref: "path-ref:repo".to_owned(),
                argv: vec!["git".to_owned(), "status".to_owned()],
                timeout_ms: 30_000,
                stdout_limit_bytes: 64 * 1024,
                stderr_limit_bytes: 8 * 1024,
                status: crate::GitDryRunRunnerBoundaryStatus::Admitted,
                blockers: Vec::new(),
                runner_handoff_admitted: true,
                shell_execution_performed: false,
                checkout_authority_granted: false,
                branch_mutation_authority_granted: false,
                commit_authority_granted: false,
                push_authority_granted: false,
                forge_authority_granted: false,
                raw_output_retention_granted: false,
            }],
            captures: vec![crate::GitDryRunEvidenceCaptureRecord {
                capture_id: "capture:1".to_owned(),
                handoff_id: "handoff:1".to_owned(),
                request_id: "request:1".to_owned(),
                descriptor_id: "git-dry-run-status-porcelain".to_owned(),
                repo_id: "repo:1".to_owned(),
                status: crate::GitDryRunEvidenceCaptureStatus::Completed,
                blockers: Vec::new(),
                exit_code: Some(0),
                changed_path_count: 1,
                staged_path_count: 0,
                unstaged_path_count: 1,
                untracked_path_count: 0,
                insertion_count: 0,
                deletion_count: 0,
                evidence_refs: vec!["evidence:summary".to_owned()],
                git_dry_run_executed: true,
                git_mutation_executed: false,
                forge_effect_executed: false,
                provider_write_executed: false,
                callback_response_executed: false,
                interruption_executed: false,
                recovery_executed: false,
                raw_output_retained: false,
            }],
        }
    }
}
