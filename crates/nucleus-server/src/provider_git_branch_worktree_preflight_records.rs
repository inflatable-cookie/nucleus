//! Preflight records for Git branch/worktree commands.

use serde::{Deserialize, Serialize};

use crate::{
    GitBranchWorktreeCommandDescriptorRecord, GitBranchWorktreeCommandDescriptorSet,
    GitBranchWorktreeCommandDescriptorStatus, GitBranchWorktreeMode,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBranchWorktreePreflightInput {
    pub descriptors: GitBranchWorktreeCommandDescriptorSet,
    pub operator_confirmed: bool,
    pub working_tree_clean: bool,
    pub isolated_target_available: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitBranchWorktreePreflightSet {
    pub preflight_set_id: String,
    pub preflights: Vec<GitBranchWorktreePreflightRecord>,
    pub skipped_descriptor_ids: Vec<String>,
    pub checkout_executed: bool,
    pub branch_created: bool,
    pub worktree_created: bool,
    pub shell_handoff_created: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitBranchWorktreePreflightRecord {
    pub preflight_id: String,
    pub descriptor_id: String,
    pub admission_id: String,
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
    pub status: GitBranchWorktreePreflightStatus,
    pub blockers: Vec<GitBranchWorktreePreflightBlocker>,
    pub checkout_executed: bool,
    pub branch_created: bool,
    pub worktree_created: bool,
    pub shell_handoff_created: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreePreflightStatus {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreePreflightBlocker {
    DescriptorNotReady,
    OperatorConfirmationMissing,
    WorkingTreeNotClean,
    IsolatedTargetUnavailable,
}

pub fn git_branch_worktree_preflight_records(
    input: GitBranchWorktreePreflightInput,
) -> GitBranchWorktreePreflightSet {
    let checks = GitBranchWorktreePreflightChecks {
        operator_confirmed: input.operator_confirmed,
        working_tree_clean: input.working_tree_clean,
        isolated_target_available: input.isolated_target_available,
    };
    let mut preflights = input
        .descriptors
        .descriptors
        .into_iter()
        .map(|descriptor| preflight_record(&checks, descriptor))
        .collect::<Vec<_>>();
    preflights.sort_by(|left, right| left.preflight_id.cmp(&right.preflight_id));

    GitBranchWorktreePreflightSet {
        preflight_set_id: "git-branch-worktree-preflight-records".to_owned(),
        skipped_descriptor_ids: preflights
            .iter()
            .filter(|preflight| preflight.status != GitBranchWorktreePreflightStatus::Ready)
            .map(|preflight| preflight.descriptor_id.clone())
            .collect(),
        preflights,
        checkout_executed: false,
        branch_created: false,
        worktree_created: false,
        shell_handoff_created: false,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GitBranchWorktreePreflightChecks {
    operator_confirmed: bool,
    working_tree_clean: bool,
    isolated_target_available: bool,
}

fn preflight_record(
    checks: &GitBranchWorktreePreflightChecks,
    descriptor: GitBranchWorktreeCommandDescriptorRecord,
) -> GitBranchWorktreePreflightRecord {
    let blockers = blockers(checks, &descriptor);
    let status = if blockers.is_empty() {
        GitBranchWorktreePreflightStatus::Ready
    } else {
        GitBranchWorktreePreflightStatus::Blocked
    };

    GitBranchWorktreePreflightRecord {
        preflight_id: format!("git-branch-worktree-preflight:{}", descriptor.descriptor_id),
        descriptor_id: descriptor.descriptor_id,
        admission_id: descriptor.admission_id,
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
        status,
        blockers,
        checkout_executed: false,
        branch_created: false,
        worktree_created: false,
        shell_handoff_created: false,
    }
}

fn blockers(
    checks: &GitBranchWorktreePreflightChecks,
    descriptor: &GitBranchWorktreeCommandDescriptorRecord,
) -> Vec<GitBranchWorktreePreflightBlocker> {
    let mut blockers = Vec::new();
    if descriptor.status != GitBranchWorktreeCommandDescriptorStatus::Ready {
        blockers.push(GitBranchWorktreePreflightBlocker::DescriptorNotReady);
    }
    if !checks.operator_confirmed {
        blockers.push(GitBranchWorktreePreflightBlocker::OperatorConfirmationMissing);
    }
    if !checks.working_tree_clean {
        blockers.push(GitBranchWorktreePreflightBlocker::WorkingTreeNotClean);
    }
    if descriptor.worktree_mode == GitBranchWorktreeMode::IsolatedWorktree
        && !checks.isolated_target_available
    {
        blockers.push(GitBranchWorktreePreflightBlocker::IsolatedTargetUnavailable);
    }
    blockers
}

#[cfg(test)]
mod tests;
