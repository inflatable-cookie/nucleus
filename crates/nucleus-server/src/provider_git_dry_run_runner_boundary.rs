//! Runner-boundary records for Git dry-run command handoff.

use serde::{Deserialize, Serialize};

use crate::{GitDryRunCommandRequestRecord, GitDryRunCommandRequestStatus};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitDryRunRunnerBoundaryInput {
    pub request: GitDryRunCommandRequestRecord,
    pub timeout_ms: u64,
    pub shell_execution_requested: bool,
    pub raw_output_retention_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitDryRunRunnerBoundaryRecord {
    pub handoff_id: String,
    pub request_id: String,
    pub descriptor_id: String,
    pub repo_id: String,
    pub cwd_ref: String,
    pub argv: Vec<String>,
    pub timeout_ms: u64,
    pub stdout_limit_bytes: usize,
    pub stderr_limit_bytes: usize,
    pub status: GitDryRunRunnerBoundaryStatus,
    pub blockers: Vec<GitDryRunRunnerBoundaryBlocker>,
    pub runner_handoff_admitted: bool,
    pub shell_execution_performed: bool,
    pub checkout_authority_granted: bool,
    pub branch_mutation_authority_granted: bool,
    pub commit_authority_granted: bool,
    pub push_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub raw_output_retention_granted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitDryRunRunnerBoundaryStatus {
    Admitted,
    Blocked,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitDryRunRunnerBoundaryBlocker {
    RequestNotAdmitted,
    EmptyArgv,
    TimeoutMissing,
    MutatingGitVerb,
    ShellExecutionRequested,
    RawOutputRetentionRequested,
}

pub fn git_dry_run_runner_boundary(
    input: GitDryRunRunnerBoundaryInput,
) -> GitDryRunRunnerBoundaryRecord {
    let blockers = blockers(&input);
    let status = status(&blockers);
    GitDryRunRunnerBoundaryRecord {
        handoff_id: format!("git-dry-run-runner-handoff:{}", input.request.request_id),
        request_id: input.request.request_id,
        descriptor_id: input.request.descriptor_id,
        repo_id: input.request.repo_id,
        cwd_ref: input.request.worktree_path_ref,
        argv: input.request.argv,
        timeout_ms: input.timeout_ms,
        stdout_limit_bytes: input.request.stdout_limit_bytes,
        stderr_limit_bytes: input.request.stderr_limit_bytes,
        runner_handoff_admitted: status == GitDryRunRunnerBoundaryStatus::Admitted,
        status,
        blockers,
        shell_execution_performed: false,
        checkout_authority_granted: false,
        branch_mutation_authority_granted: false,
        commit_authority_granted: false,
        push_authority_granted: false,
        forge_authority_granted: false,
        raw_output_retention_granted: false,
    }
}

fn blockers(input: &GitDryRunRunnerBoundaryInput) -> Vec<GitDryRunRunnerBoundaryBlocker> {
    let mut blockers = Vec::new();
    if input.request.status != GitDryRunCommandRequestStatus::Admitted {
        blockers.push(GitDryRunRunnerBoundaryBlocker::RequestNotAdmitted);
    }
    if input.request.argv.is_empty() {
        blockers.push(GitDryRunRunnerBoundaryBlocker::EmptyArgv);
    }
    if input.timeout_ms == 0 {
        blockers.push(GitDryRunRunnerBoundaryBlocker::TimeoutMissing);
    }
    if contains_mutating_git_verb(&input.request.argv) {
        blockers.push(GitDryRunRunnerBoundaryBlocker::MutatingGitVerb);
    }
    if input.shell_execution_requested {
        blockers.push(GitDryRunRunnerBoundaryBlocker::ShellExecutionRequested);
    }
    if input.raw_output_retention_requested {
        blockers.push(GitDryRunRunnerBoundaryBlocker::RawOutputRetentionRequested);
    }
    blockers
}

fn contains_mutating_git_verb(argv: &[String]) -> bool {
    let mut parts = argv.iter().map(String::as_str);
    if parts.next() != Some("git") {
        return false;
    }
    parts.any(|part| {
        matches!(
            part,
            "add" | "checkout" | "commit" | "merge" | "push" | "reset" | "switch"
        )
    })
}

fn status(blockers: &[GitDryRunRunnerBoundaryBlocker]) -> GitDryRunRunnerBoundaryStatus {
    if blockers.is_empty() {
        GitDryRunRunnerBoundaryStatus::Admitted
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            GitDryRunRunnerBoundaryBlocker::RequestNotAdmitted
                | GitDryRunRunnerBoundaryBlocker::EmptyArgv
                | GitDryRunRunnerBoundaryBlocker::TimeoutMissing
        )
    }) {
        GitDryRunRunnerBoundaryStatus::RepairRequired
    } else {
        GitDryRunRunnerBoundaryStatus::Blocked
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_dry_run_runner_boundary_admits_non_mutating_handoff() {
        let record = git_dry_run_runner_boundary(input(false));

        assert_eq!(record.status, GitDryRunRunnerBoundaryStatus::Admitted);
        assert_eq!(record.argv[0], "git");
        assert!(record.runner_handoff_admitted);
        assert!(!record.shell_execution_performed);
        assert!(!record.commit_authority_granted);
    }

    #[test]
    fn git_dry_run_runner_boundary_blocks_shell_or_raw_output_requests() {
        let record = git_dry_run_runner_boundary(input(true));

        assert_eq!(record.status, GitDryRunRunnerBoundaryStatus::Blocked);
        assert!(record
            .blockers
            .contains(&GitDryRunRunnerBoundaryBlocker::ShellExecutionRequested));
        assert!(record
            .blockers
            .contains(&GitDryRunRunnerBoundaryBlocker::RawOutputRetentionRequested));
        assert!(!record.runner_handoff_admitted);
        assert!(!record.raw_output_retention_granted);
    }

    fn input(blocked: bool) -> GitDryRunRunnerBoundaryInput {
        GitDryRunRunnerBoundaryInput {
            request: crate::GitDryRunCommandRequestRecord {
                request_id: "request:1".to_owned(),
                admission_id: "admission:1".to_owned(),
                descriptor_id: "git-dry-run-status-porcelain".to_owned(),
                repo_id: "repo:1".to_owned(),
                worktree_path_ref: "path-ref:repo".to_owned(),
                evidence_root_ref: "evidence-root:1".to_owned(),
                argv: vec![
                    "git".to_owned(),
                    "status".to_owned(),
                    "--porcelain=v1".to_owned(),
                    "-z".to_owned(),
                ],
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
            },
            timeout_ms: 30_000,
            shell_execution_requested: blocked,
            raw_output_retention_requested: blocked,
        }
    }
}
