//! Preflight records for Git commit command descriptors.

use serde::{Deserialize, Serialize};

use crate::{
    GitBranchWorktreeMode, GitCommitCommandDescriptorRecord, GitCommitCommandDescriptorSet,
    GitCommitCommandDescriptorStatus, GitCommitMessageSource,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCommitPreflightInput {
    pub descriptors: GitCommitCommandDescriptorSet,
    pub operator_confirmed: bool,
    pub commit_ready_changes_present: bool,
    pub commit_message_approved: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitCommitPreflightSet {
    pub preflight_set_id: String,
    pub preflights: Vec<GitCommitPreflightRecord>,
    pub skipped_descriptor_ids: Vec<String>,
    pub shell_handoff_created: bool,
    pub commit_created: bool,
    pub push_executed: bool,
    pub pull_request_created: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitCommitPreflightRecord {
    pub preflight_id: String,
    pub descriptor_id: String,
    pub admission_id: String,
    pub branch_worktree_evidence_id: String,
    pub branch_worktree_outcome_id: String,
    pub branch_worktree_handoff_id: String,
    pub branch_worktree_preflight_id: String,
    pub branch_worktree_descriptor_id: String,
    pub branch_worktree_admission_id: String,
    pub dry_run_evidence_id: String,
    pub dry_run_outcome_id: String,
    pub dry_run_handoff_id: String,
    pub request_id: String,
    pub authority_id: String,
    pub git_plan_id: String,
    pub task_id: String,
    pub repo_id: String,
    pub operator_ref: String,
    pub worktree_mode: GitBranchWorktreeMode,
    pub commit_message_source: Option<GitCommitMessageSource>,
    pub status: GitCommitPreflightStatus,
    pub blockers: Vec<GitCommitPreflightBlocker>,
    pub shell_handoff_created: bool,
    pub commit_created: bool,
    pub push_executed: bool,
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitCommitPreflightStatus {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitCommitPreflightBlocker {
    DescriptorNotReady,
    OperatorConfirmationMissing,
    CommitReadyChangesMissing,
    CommitMessageApprovalMissing,
}

pub fn git_commit_preflight_records(input: GitCommitPreflightInput) -> GitCommitPreflightSet {
    let checks = GitCommitPreflightChecks {
        operator_confirmed: input.operator_confirmed,
        commit_ready_changes_present: input.commit_ready_changes_present,
        commit_message_approved: input.commit_message_approved,
    };
    let mut preflights = input
        .descriptors
        .descriptors
        .into_iter()
        .map(|descriptor| preflight_record(&checks, descriptor))
        .collect::<Vec<_>>();
    preflights.sort_by(|left, right| left.preflight_id.cmp(&right.preflight_id));

    GitCommitPreflightSet {
        preflight_set_id: "git-commit-preflight-records".to_owned(),
        skipped_descriptor_ids: preflights
            .iter()
            .filter(|preflight| preflight.status != GitCommitPreflightStatus::Ready)
            .map(|preflight| preflight.descriptor_id.clone())
            .collect(),
        preflights,
        shell_handoff_created: false,
        commit_created: false,
        push_executed: false,
        pull_request_created: false,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GitCommitPreflightChecks {
    operator_confirmed: bool,
    commit_ready_changes_present: bool,
    commit_message_approved: bool,
}

fn preflight_record(
    checks: &GitCommitPreflightChecks,
    descriptor: GitCommitCommandDescriptorRecord,
) -> GitCommitPreflightRecord {
    let blockers = blockers(checks, &descriptor);
    let status = if blockers.is_empty() {
        GitCommitPreflightStatus::Ready
    } else {
        GitCommitPreflightStatus::Blocked
    };

    GitCommitPreflightRecord {
        preflight_id: format!("git-commit-preflight:{}", descriptor.descriptor_id),
        descriptor_id: descriptor.descriptor_id,
        admission_id: descriptor.admission_id,
        branch_worktree_evidence_id: descriptor.branch_worktree_evidence_id,
        branch_worktree_outcome_id: descriptor.branch_worktree_outcome_id,
        branch_worktree_handoff_id: descriptor.branch_worktree_handoff_id,
        branch_worktree_preflight_id: descriptor.branch_worktree_preflight_id,
        branch_worktree_descriptor_id: descriptor.branch_worktree_descriptor_id,
        branch_worktree_admission_id: descriptor.branch_worktree_admission_id,
        dry_run_evidence_id: descriptor.dry_run_evidence_id,
        dry_run_outcome_id: descriptor.dry_run_outcome_id,
        dry_run_handoff_id: descriptor.dry_run_handoff_id,
        request_id: descriptor.request_id,
        authority_id: descriptor.authority_id,
        git_plan_id: descriptor.git_plan_id,
        task_id: descriptor.task_id,
        repo_id: descriptor.repo_id,
        operator_ref: descriptor.operator_ref,
        worktree_mode: descriptor.worktree_mode,
        commit_message_source: descriptor.commit_message_source,
        status,
        blockers,
        shell_handoff_created: false,
        commit_created: false,
        push_executed: false,
        pull_request_created: false,
        forge_effect_executed: false,
        raw_output_retained: false,
    }
}

fn blockers(
    checks: &GitCommitPreflightChecks,
    descriptor: &GitCommitCommandDescriptorRecord,
) -> Vec<GitCommitPreflightBlocker> {
    let mut blockers = Vec::new();
    if descriptor.status != GitCommitCommandDescriptorStatus::Ready {
        blockers.push(GitCommitPreflightBlocker::DescriptorNotReady);
    }
    if !checks.operator_confirmed {
        blockers.push(GitCommitPreflightBlocker::OperatorConfirmationMissing);
    }
    if !checks.commit_ready_changes_present {
        blockers.push(GitCommitPreflightBlocker::CommitReadyChangesMissing);
    }
    if !checks.commit_message_approved {
        blockers.push(GitCommitPreflightBlocker::CommitMessageApprovalMissing);
    }
    blockers
}

#[cfg(test)]
mod tests;
