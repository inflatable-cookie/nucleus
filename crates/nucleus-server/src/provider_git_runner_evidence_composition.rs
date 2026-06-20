//! Compose transient read-only Git runner output into sanitized evidence records.

use crate::{
    git_diff_stat_summary_parser, git_dry_run_evidence_capture, git_status_summary_parser,
    GitDiffStatSummaryStatus, GitDryRunEvidenceCaptureInput, GitDryRunEvidenceCaptureRecord,
    GitDryRunEvidenceCaptureStatus, GitDryRunRunnerBoundaryRecord, GitReadOnlyRunnerOutput,
    GitReadOnlyRunnerStatus, GitStatusSummaryStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitRunnerOutputEvidenceCaptureInput {
    pub handoff: GitDryRunRunnerBoundaryRecord,
    pub runner_output: GitReadOnlyRunnerOutput,
    pub evidence_refs: Vec<String>,
}

pub fn git_runner_output_to_evidence_capture(
    input: GitRunnerOutputEvidenceCaptureInput,
) -> GitDryRunEvidenceCaptureRecord {
    let summary = summary(&input);
    git_dry_run_evidence_capture(GitDryRunEvidenceCaptureInput {
        handoff: input.handoff,
        status: summary.status,
        exit_code: input.runner_output.record.exit_code,
        changed_path_count: summary.changed_path_count,
        staged_path_count: summary.staged_path_count,
        unstaged_path_count: summary.unstaged_path_count,
        untracked_path_count: summary.untracked_path_count,
        insertion_count: summary.insertion_count,
        deletion_count: summary.deletion_count,
        evidence_refs: input.evidence_refs,
        raw_stdout_present: false,
        raw_stderr_present: false,
        raw_diff_present: false,
    })
}

fn summary(input: &GitRunnerOutputEvidenceCaptureInput) -> GitRunnerEvidenceSummary {
    match input.runner_output.record.status {
        GitReadOnlyRunnerStatus::Blocked => return GitRunnerEvidenceSummary::blocked(),
        GitReadOnlyRunnerStatus::RepairRequired => return GitRunnerEvidenceSummary::repair(),
        GitReadOnlyRunnerStatus::Failed => return GitRunnerEvidenceSummary::failed(),
        GitReadOnlyRunnerStatus::Completed => {}
    }

    match input.handoff.descriptor_id.as_str() {
        "git-dry-run-status-porcelain" => {
            let status = git_status_summary_parser(&input.runner_output.stdout);
            GitRunnerEvidenceSummary {
                status: if status.status == GitStatusSummaryStatus::Completed {
                    GitDryRunEvidenceCaptureStatus::Completed
                } else {
                    GitDryRunEvidenceCaptureStatus::RepairRequired
                },
                changed_path_count: status.changed_path_count,
                staged_path_count: status.staged_path_count,
                unstaged_path_count: status.unstaged_path_count,
                untracked_path_count: status.untracked_path_count,
                insertion_count: 0,
                deletion_count: 0,
            }
        }
        "git-dry-run-diff-stat" => {
            let diff = String::from_utf8_lossy(&input.runner_output.stdout);
            let stat = git_diff_stat_summary_parser(&diff);
            GitRunnerEvidenceSummary {
                status: match stat.status {
                    GitDiffStatSummaryStatus::Completed | GitDiffStatSummaryStatus::Empty => {
                        GitDryRunEvidenceCaptureStatus::Completed
                    }
                    GitDiffStatSummaryStatus::RepairRequired => {
                        GitDryRunEvidenceCaptureStatus::RepairRequired
                    }
                },
                changed_path_count: stat.changed_path_count,
                staged_path_count: 0,
                unstaged_path_count: stat.changed_path_count,
                untracked_path_count: 0,
                insertion_count: stat.insertion_count,
                deletion_count: stat.deletion_count,
            }
        }
        _ => GitRunnerEvidenceSummary::repair(),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GitRunnerEvidenceSummary {
    status: GitDryRunEvidenceCaptureStatus,
    changed_path_count: usize,
    staged_path_count: usize,
    unstaged_path_count: usize,
    untracked_path_count: usize,
    insertion_count: usize,
    deletion_count: usize,
}

impl GitRunnerEvidenceSummary {
    fn failed() -> Self {
        Self {
            status: GitDryRunEvidenceCaptureStatus::Failed,
            changed_path_count: 0,
            staged_path_count: 0,
            unstaged_path_count: 0,
            untracked_path_count: 0,
            insertion_count: 0,
            deletion_count: 0,
        }
    }

    fn blocked() -> Self {
        Self {
            status: GitDryRunEvidenceCaptureStatus::Blocked,
            changed_path_count: 0,
            staged_path_count: 0,
            unstaged_path_count: 0,
            untracked_path_count: 0,
            insertion_count: 0,
            deletion_count: 0,
        }
    }

    fn repair() -> Self {
        Self {
            status: GitDryRunEvidenceCaptureStatus::RepairRequired,
            changed_path_count: 0,
            staged_path_count: 0,
            unstaged_path_count: 0,
            untracked_path_count: 0,
            insertion_count: 0,
            deletion_count: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_local_store::SqliteBackend;

    use crate::{
        git_dry_run_execution_control_dto,
        git_dry_run_execution_diagnostics_from_persisted_records, persist_git_dry_run_execution,
        read_git_dry_run_executions, GitDryRunExecutionPersistenceInput,
        GitDryRunExecutionPersistenceStatus, GitReadOnlyRunnerRecord,
    };

    #[test]
    fn git_runner_output_to_evidence_capture_maps_status_counts() {
        let capture = git_runner_output_to_evidence_capture(input(
            "git-dry-run-status-porcelain",
            b"M  src/lib.rs\0 M README.md\0?? new.txt\0".to_vec(),
        ));

        assert_eq!(capture.status, GitDryRunEvidenceCaptureStatus::Completed);
        assert_eq!(capture.changed_path_count, 3);
        assert_eq!(capture.staged_path_count, 1);
        assert_eq!(capture.unstaged_path_count, 1);
        assert_eq!(capture.untracked_path_count, 1);
        assert!(capture.git_dry_run_executed);
        assert!(!capture.raw_output_retained);
    }

    #[test]
    fn git_runner_output_to_evidence_capture_maps_diff_stat_counts() {
        let capture = git_runner_output_to_evidence_capture(input(
            "git-dry-run-diff-stat",
            b" src/lib.rs | 4 +++-\n 1 file changed, 3 insertions(+), 1 deletion(-)\n".to_vec(),
        ));

        assert_eq!(capture.status, GitDryRunEvidenceCaptureStatus::Completed);
        assert_eq!(capture.changed_path_count, 1);
        assert_eq!(capture.insertion_count, 3);
        assert_eq!(capture.deletion_count, 1);
        assert!(!capture.raw_output_retained);
    }

    #[test]
    fn git_runner_output_to_evidence_capture_marks_malformed_output_repair_required() {
        let capture = git_runner_output_to_evidence_capture(input(
            "git-dry-run-status-porcelain",
            b"x\0".to_vec(),
        ));

        assert_eq!(
            capture.status,
            GitDryRunEvidenceCaptureStatus::RepairRequired
        );
        assert_eq!(capture.changed_path_count, 0);
        assert!(!capture.raw_output_retained);
    }

    #[test]
    fn git_runner_evidence_persistence_composition_persists_composed_records() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = crate::ServerStateService::new(SqliteBackend::new(
            temp_dir.path().join("nucleus.sqlite"),
        ));
        let capture = git_runner_output_to_evidence_capture(input(
            "git-dry-run-diff-stat",
            b" src/lib.rs | 4 +++-\n 1 file changed, 3 insertions(+), 1 deletion(-)\n".to_vec(),
        ));

        let persisted =
            persist_git_dry_run_execution(&state, persistence_input(capture, Vec::new()))
                .expect("persist composed record");
        let duplicate = persist_git_dry_run_execution(
            &state,
            persistence_input(
                git_runner_output_to_evidence_capture(input(
                    "git-dry-run-diff-stat",
                    b" src/lib.rs | 4 +++-\n 1 file changed, 3 insertions(+), 1 deletion(-)\n"
                        .to_vec(),
                )),
                vec![persisted.persisted_execution_id.clone()],
            ),
        )
        .expect("duplicate");
        let records = read_git_dry_run_executions(&state).expect("read records");

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].changed_path_count, 1);
        assert_eq!(records[0].insertion_count, 3);
        assert_eq!(records[0].evidence_refs, vec!["evidence:runner"]);
        assert_eq!(
            duplicate.persistence_status,
            GitDryRunExecutionPersistenceStatus::DuplicateNoop
        );
        assert!(!records[0].raw_output_retained);
    }

    #[test]
    fn git_runner_control_diagnostics_refresh_reads_composed_records() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = crate::ServerStateService::new(SqliteBackend::new(
            temp_dir.path().join("nucleus.sqlite"),
        ));
        let capture = git_runner_output_to_evidence_capture(input(
            "git-dry-run-status-porcelain",
            b"?? new.txt\0".to_vec(),
        ));
        persist_git_dry_run_execution(&state, persistence_input(capture, Vec::new()))
            .expect("persist composed record");

        let records = read_git_dry_run_executions(&state).expect("read records");
        let dto = git_dry_run_execution_control_dto(
            git_dry_run_execution_diagnostics_from_persisted_records(records),
        );

        assert_eq!(dto.execution_count, 1);
        assert_eq!(dto.completed_count, 1);
        assert_eq!(dto.dry_run_executed_count, 1);
        assert!(!dto.commit_executed);
        assert!(!dto.raw_output_retained);
    }

    #[test]
    fn git_runner_integrated_authority_keeps_raw_output_transient() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = crate::ServerStateService::new(SqliteBackend::new(
            temp_dir.path().join("nucleus.sqlite"),
        ));
        let runner_output = output("git-dry-run-status-porcelain", b"?? new.txt\0".to_vec());
        let transient_stdout_len = runner_output.stdout.len();
        let capture = git_runner_output_to_evidence_capture(GitRunnerOutputEvidenceCaptureInput {
            handoff: handoff("git-dry-run-status-porcelain"),
            runner_output,
            evidence_refs: vec!["evidence:runner".to_owned()],
        });
        persist_git_dry_run_execution(&state, persistence_input(capture, Vec::new()))
            .expect("persist composed record");
        let record = read_git_dry_run_executions(&state)
            .expect("read records")
            .pop()
            .expect("persisted record");

        assert!(transient_stdout_len > 0);
        assert_eq!(record.changed_path_count, 1);
        assert!(!record.raw_output_retained);
        assert!(!record.checkout_executed);
        assert!(!record.branch_mutation_executed);
        assert!(!record.commit_executed);
        assert!(!record.push_executed);
        assert!(!record.provider_write_executed);
        assert!(!record.callback_response_executed);
        assert!(!record.interruption_executed);
        assert!(!record.recovery_executed);
    }

    fn input(descriptor_id: &str, stdout: Vec<u8>) -> GitRunnerOutputEvidenceCaptureInput {
        GitRunnerOutputEvidenceCaptureInput {
            handoff: handoff(descriptor_id),
            runner_output: output(descriptor_id, stdout),
            evidence_refs: vec!["evidence:runner".to_owned()],
        }
    }

    fn output(descriptor_id: &str, stdout: Vec<u8>) -> GitReadOnlyRunnerOutput {
        let stdout_size_bytes = stdout.len();
        GitReadOnlyRunnerOutput {
            record: GitReadOnlyRunnerRecord {
                runner_id: format!("runner:{descriptor_id}"),
                handoff_id: format!("handoff:{descriptor_id}"),
                descriptor_id: descriptor_id.to_owned(),
                repo_id: "repo:1".to_owned(),
                status: GitReadOnlyRunnerStatus::Completed,
                blockers: Vec::new(),
                exit_code: Some(0),
                stdout_size_bytes,
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
            },
            stdout,
            stderr: Vec::new(),
        }
    }

    fn handoff(descriptor_id: &str) -> GitDryRunRunnerBoundaryRecord {
        GitDryRunRunnerBoundaryRecord {
            handoff_id: format!("handoff:{descriptor_id}"),
            request_id: format!("request:{descriptor_id}"),
            descriptor_id: descriptor_id.to_owned(),
            repo_id: "repo:1".to_owned(),
            cwd_ref: "path-ref:repo".to_owned(),
            argv: match descriptor_id {
                "git-dry-run-status-porcelain" => {
                    vec!["git", "status", "--porcelain=v1", "-z"]
                }
                "git-dry-run-diff-stat" => vec!["git", "diff", "--stat", "--no-ext-diff"],
                _ => vec!["git", "status"],
            }
            .into_iter()
            .map(str::to_owned)
            .collect(),
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
        }
    }

    fn persistence_input(
        capture: GitDryRunEvidenceCaptureRecord,
        existing_execution_ids: Vec<String>,
    ) -> GitDryRunExecutionPersistenceInput {
        GitDryRunExecutionPersistenceInput {
            capture,
            existing_execution_ids,
            raw_stdout_present: false,
            raw_stderr_present: false,
            raw_diff_present: false,
            checkout_requested: false,
            branch_mutation_requested: false,
            commit_requested: false,
            push_requested: false,
            forge_requested: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
        }
    }
}
