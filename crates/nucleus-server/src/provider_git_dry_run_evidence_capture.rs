//! Sanitized evidence capture for Git dry-run command outcomes.

use serde::{Deserialize, Serialize};

use crate::{GitDryRunRunnerBoundaryRecord, GitDryRunRunnerBoundaryStatus};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitDryRunEvidenceCaptureInput {
    pub handoff: GitDryRunRunnerBoundaryRecord,
    pub status: GitDryRunEvidenceCaptureStatus,
    pub exit_code: Option<i32>,
    pub changed_path_count: usize,
    pub staged_path_count: usize,
    pub unstaged_path_count: usize,
    pub untracked_path_count: usize,
    pub insertion_count: usize,
    pub deletion_count: usize,
    pub evidence_refs: Vec<String>,
    pub raw_stdout_present: bool,
    pub raw_stderr_present: bool,
    pub raw_diff_present: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitDryRunEvidenceCaptureRecord {
    pub capture_id: String,
    pub handoff_id: String,
    pub request_id: String,
    pub descriptor_id: String,
    pub repo_id: String,
    pub status: GitDryRunEvidenceCaptureStatus,
    pub blockers: Vec<GitDryRunEvidenceCaptureBlocker>,
    pub exit_code: Option<i32>,
    pub changed_path_count: usize,
    pub staged_path_count: usize,
    pub unstaged_path_count: usize,
    pub untracked_path_count: usize,
    pub insertion_count: usize,
    pub deletion_count: usize,
    pub evidence_refs: Vec<String>,
    pub git_dry_run_executed: bool,
    pub git_mutation_executed: bool,
    pub forge_effect_executed: bool,
    pub provider_write_executed: bool,
    pub callback_response_executed: bool,
    pub interruption_executed: bool,
    pub recovery_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitDryRunEvidenceCaptureStatus {
    Completed,
    Failed,
    TimedOut,
    Blocked,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitDryRunEvidenceCaptureBlocker {
    HandoffNotAdmitted,
    EvidenceRefsMissing,
    RawStdoutPresent,
    RawStderrPresent,
    RawDiffPresent,
}

pub fn git_dry_run_evidence_capture(
    input: GitDryRunEvidenceCaptureInput,
) -> GitDryRunEvidenceCaptureRecord {
    let blockers = blockers(&input);
    let status = if blockers.is_empty() {
        input.status
    } else if blockers
        .iter()
        .any(|blocker| matches!(blocker, GitDryRunEvidenceCaptureBlocker::HandoffNotAdmitted))
    {
        GitDryRunEvidenceCaptureStatus::RepairRequired
    } else {
        GitDryRunEvidenceCaptureStatus::Blocked
    };
    let git_dry_run_executed = blockers.is_empty()
        && matches!(
            status,
            GitDryRunEvidenceCaptureStatus::Completed
                | GitDryRunEvidenceCaptureStatus::Failed
                | GitDryRunEvidenceCaptureStatus::TimedOut
        );

    GitDryRunEvidenceCaptureRecord {
        capture_id: format!("git-dry-run-evidence-capture:{}", input.handoff.handoff_id),
        handoff_id: input.handoff.handoff_id,
        request_id: input.handoff.request_id,
        descriptor_id: input.handoff.descriptor_id,
        repo_id: input.handoff.repo_id,
        status,
        blockers,
        exit_code: input.exit_code,
        changed_path_count: input.changed_path_count,
        staged_path_count: input.staged_path_count,
        unstaged_path_count: input.unstaged_path_count,
        untracked_path_count: input.untracked_path_count,
        insertion_count: input.insertion_count,
        deletion_count: input.deletion_count,
        evidence_refs: unique_sorted(input.evidence_refs),
        git_dry_run_executed,
        git_mutation_executed: false,
        forge_effect_executed: false,
        provider_write_executed: false,
        callback_response_executed: false,
        interruption_executed: false,
        recovery_executed: false,
        raw_output_retained: false,
    }
}

fn blockers(input: &GitDryRunEvidenceCaptureInput) -> Vec<GitDryRunEvidenceCaptureBlocker> {
    let mut blockers = Vec::new();
    if input.handoff.status != GitDryRunRunnerBoundaryStatus::Admitted {
        blockers.push(GitDryRunEvidenceCaptureBlocker::HandoffNotAdmitted);
    }
    if input.evidence_refs.is_empty() {
        blockers.push(GitDryRunEvidenceCaptureBlocker::EvidenceRefsMissing);
    }
    if input.raw_stdout_present {
        blockers.push(GitDryRunEvidenceCaptureBlocker::RawStdoutPresent);
    }
    if input.raw_stderr_present {
        blockers.push(GitDryRunEvidenceCaptureBlocker::RawStderrPresent);
    }
    if input.raw_diff_present {
        blockers.push(GitDryRunEvidenceCaptureBlocker::RawDiffPresent);
    }
    blockers
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_dry_run_evidence_capture_keeps_bounded_summary_refs() {
        let record = git_dry_run_evidence_capture(input(false));

        assert_eq!(record.status, GitDryRunEvidenceCaptureStatus::Completed);
        assert_eq!(record.changed_path_count, 3);
        assert_eq!(record.insertion_count, 12);
        assert!(record.git_dry_run_executed);
        assert!(!record.git_mutation_executed);
        assert!(!record.raw_output_retained);
    }

    #[test]
    fn git_dry_run_evidence_capture_blocks_raw_output_material() {
        let record = git_dry_run_evidence_capture(input(true));

        assert_eq!(record.status, GitDryRunEvidenceCaptureStatus::Blocked);
        assert!(record
            .blockers
            .contains(&GitDryRunEvidenceCaptureBlocker::RawStdoutPresent));
        assert!(record
            .blockers
            .contains(&GitDryRunEvidenceCaptureBlocker::RawDiffPresent));
        assert!(!record.git_dry_run_executed);
        assert!(!record.raw_output_retained);
    }

    fn input(blocked: bool) -> GitDryRunEvidenceCaptureInput {
        GitDryRunEvidenceCaptureInput {
            handoff: crate::GitDryRunRunnerBoundaryRecord {
                handoff_id: "handoff:1".to_owned(),
                request_id: "request:1".to_owned(),
                descriptor_id: "git-dry-run-diff-stat".to_owned(),
                repo_id: "repo:1".to_owned(),
                cwd_ref: "path-ref:repo".to_owned(),
                argv: vec![
                    "git".to_owned(),
                    "diff".to_owned(),
                    "--stat".to_owned(),
                    "--no-ext-diff".to_owned(),
                ],
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
            },
            status: GitDryRunEvidenceCaptureStatus::Completed,
            exit_code: Some(0),
            changed_path_count: 3,
            staged_path_count: 1,
            unstaged_path_count: 1,
            untracked_path_count: 1,
            insertion_count: 12,
            deletion_count: 4,
            evidence_refs: vec!["evidence:summary".to_owned()],
            raw_stdout_present: blocked,
            raw_stderr_present: false,
            raw_diff_present: blocked,
        }
    }
}
