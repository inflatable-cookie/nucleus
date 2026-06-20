//! Constrained read-only Git runner for dry-run command handoffs.

use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::{GitDryRunRunnerBoundaryRecord, GitDryRunRunnerBoundaryStatus};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitReadOnlyRunnerInput {
    pub handoff: GitDryRunRunnerBoundaryRecord,
    pub working_directory: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitReadOnlyRunnerOutput {
    pub record: GitReadOnlyRunnerRecord,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitReadOnlyRunnerRecord {
    pub runner_id: String,
    pub handoff_id: String,
    pub descriptor_id: String,
    pub repo_id: String,
    pub status: GitReadOnlyRunnerStatus,
    pub blockers: Vec<GitReadOnlyRunnerBlocker>,
    pub exit_code: Option<i32>,
    pub stdout_size_bytes: usize,
    pub stderr_size_bytes: usize,
    pub git_read_only_command_executed: bool,
    pub raw_output_persisted: bool,
    pub checkout_executed: bool,
    pub branch_mutation_executed: bool,
    pub commit_executed: bool,
    pub push_executed: bool,
    pub forge_effect_executed: bool,
    pub provider_write_executed: bool,
    pub callback_response_executed: bool,
    pub interruption_executed: bool,
    pub recovery_executed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitReadOnlyRunnerStatus {
    Completed,
    Failed,
    Blocked,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitReadOnlyRunnerBlocker {
    HandoffNotAdmitted,
    UnknownDescriptor,
    MutatingGitVerb,
    WorkingDirectoryMissing,
    SpawnFailed,
}

pub fn git_read_only_runner_adapter(input: GitReadOnlyRunnerInput) -> GitReadOnlyRunnerOutput {
    let blockers = blockers(&input);
    if !blockers.is_empty() {
        return output(
            input.handoff,
            GitReadOnlyRunnerStatus::Blocked,
            blockers,
            None,
            Vec::new(),
            Vec::new(),
        );
    }

    let Some((program, args)) = input.handoff.argv.split_first() else {
        return output(
            input.handoff,
            GitReadOnlyRunnerStatus::RepairRequired,
            vec![GitReadOnlyRunnerBlocker::UnknownDescriptor],
            None,
            Vec::new(),
            Vec::new(),
        );
    };

    match Command::new(program)
        .args(args)
        .current_dir(input.working_directory)
        .output()
    {
        Ok(process_output) => {
            let status = if process_output.status.success() {
                GitReadOnlyRunnerStatus::Completed
            } else {
                GitReadOnlyRunnerStatus::Failed
            };
            output(
                input.handoff,
                status,
                Vec::new(),
                process_output.status.code(),
                process_output.stdout,
                process_output.stderr,
            )
        }
        Err(_) => output(
            input.handoff,
            GitReadOnlyRunnerStatus::RepairRequired,
            vec![GitReadOnlyRunnerBlocker::SpawnFailed],
            None,
            Vec::new(),
            Vec::new(),
        ),
    }
}

fn blockers(input: &GitReadOnlyRunnerInput) -> Vec<GitReadOnlyRunnerBlocker> {
    let mut blockers = Vec::new();
    if input.handoff.status != GitDryRunRunnerBoundaryStatus::Admitted {
        blockers.push(GitReadOnlyRunnerBlocker::HandoffNotAdmitted);
    }
    if !matches!(
        input.handoff.descriptor_id.as_str(),
        "git-dry-run-status-porcelain" | "git-dry-run-diff-stat"
    ) {
        blockers.push(GitReadOnlyRunnerBlocker::UnknownDescriptor);
    }
    if contains_mutating_git_verb(&input.handoff.argv) {
        blockers.push(GitReadOnlyRunnerBlocker::MutatingGitVerb);
    }
    if !input.working_directory.exists() {
        blockers.push(GitReadOnlyRunnerBlocker::WorkingDirectoryMissing);
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

fn output(
    handoff: GitDryRunRunnerBoundaryRecord,
    status: GitReadOnlyRunnerStatus,
    blockers: Vec<GitReadOnlyRunnerBlocker>,
    exit_code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
) -> GitReadOnlyRunnerOutput {
    let stdout_size_bytes = stdout.len();
    let stderr_size_bytes = stderr.len();
    let executed = blockers.is_empty()
        && matches!(
            status,
            GitReadOnlyRunnerStatus::Completed | GitReadOnlyRunnerStatus::Failed
        );
    GitReadOnlyRunnerOutput {
        record: GitReadOnlyRunnerRecord {
            runner_id: format!("git-read-only-runner:{}", handoff.handoff_id),
            handoff_id: handoff.handoff_id,
            descriptor_id: handoff.descriptor_id,
            repo_id: handoff.repo_id,
            status,
            blockers,
            exit_code,
            stdout_size_bytes,
            stderr_size_bytes,
            git_read_only_command_executed: executed,
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
        },
        stdout,
        stderr,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_read_only_runner_adapter_executes_status_in_temp_repo() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        run_git(temp_dir.path(), &["init"]);
        std::fs::write(temp_dir.path().join("file.txt"), "hello").expect("write file");

        let output = git_read_only_runner_adapter(GitReadOnlyRunnerInput {
            handoff: handoff(
                "git-dry-run-status-porcelain",
                vec!["git", "status", "--porcelain=v1", "-z"],
            ),
            working_directory: temp_dir.path().to_path_buf(),
        });

        assert_eq!(output.record.status, GitReadOnlyRunnerStatus::Completed);
        assert!(output.record.git_read_only_command_executed);
        assert!(!output.stdout.is_empty());
        assert!(!output.record.raw_output_persisted);
        assert!(!output.record.commit_executed);
    }

    #[test]
    fn git_read_only_runner_adapter_rejects_mutating_or_unknown_handoffs() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let output = git_read_only_runner_adapter(GitReadOnlyRunnerInput {
            handoff: handoff("git-commit", vec!["git", "commit", "-m", "bad"]),
            working_directory: temp_dir.path().to_path_buf(),
        });

        assert_eq!(output.record.status, GitReadOnlyRunnerStatus::Blocked);
        assert!(output
            .record
            .blockers
            .contains(&GitReadOnlyRunnerBlocker::UnknownDescriptor));
        assert!(output
            .record
            .blockers
            .contains(&GitReadOnlyRunnerBlocker::MutatingGitVerb));
        assert!(!output.record.git_read_only_command_executed);
        assert!(!output.record.commit_executed);
    }

    pub(crate) fn handoff(descriptor_id: &str, argv: Vec<&str>) -> GitDryRunRunnerBoundaryRecord {
        GitDryRunRunnerBoundaryRecord {
            handoff_id: format!("handoff:{descriptor_id}"),
            request_id: "request:1".to_owned(),
            descriptor_id: descriptor_id.to_owned(),
            repo_id: "repo:1".to_owned(),
            cwd_ref: "path-ref:repo".to_owned(),
            argv: argv.into_iter().map(str::to_owned).collect(),
            timeout_ms: 30_000,
            stdout_limit_bytes: 64 * 1024,
            stderr_limit_bytes: 8 * 1024,
            status: GitDryRunRunnerBoundaryStatus::Admitted,
            blockers: Vec::new(),
            runner_handoff_admitted: true,
            shell_execution_performed: false,
            checkout_authority_granted: false,
            branch_mutation_authority_granted: false,
            commit_authority_granted: false,
            push_authority_granted: false,
            forge_authority_granted: false,
            raw_output_retention_granted: false,
        }
    }

    fn run_git(cwd: &std::path::Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .expect("run git");
        assert!(status.success());
    }
}
