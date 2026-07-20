//! Stopped-by-default execution handoff records for Git branch/worktree commands.

use crate::provider_no_effects::ForgeScmNoEffects;
use serde::{Deserialize, Serialize};

use crate::{
    GitBranchWorktreeMode, GitBranchWorktreePreflightRecord, GitBranchWorktreePreflightSet,
    GitBranchWorktreePreflightStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBranchWorktreeExecutionHandoffInput {
    pub preflights: GitBranchWorktreePreflightSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitBranchWorktreeExecutionHandoffSet {
    pub handoff_set_id: String,
    pub handoffs: Vec<GitBranchWorktreeExecutionHandoffRecord>,
    pub skipped_preflight_ids: Vec<String>,
    pub shell_handoff_created: bool,
    pub checkout_executed: bool,
    pub branch_created: bool,
    pub worktree_created: bool,
    pub commit_created: bool,
    pub push_executed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitBranchWorktreeExecutionHandoffRecord {
    pub handoff_id: String,
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
    pub status: GitBranchWorktreeExecutionHandoffStatus,
    pub blockers: Vec<GitBranchWorktreeExecutionHandoffBlocker>,
    pub runner_handoff_admitted: bool,
    pub shell_handoff_created: bool,
    pub checkout_executed: bool,
    pub branch_created: bool,
    pub worktree_created: bool,
    pub commit_created: bool,
    pub push_executed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeExecutionHandoffStatus {
    Admitted,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeExecutionHandoffBlocker {
    PreflightNotReady,
}

pub fn git_branch_worktree_execution_handoff(
    input: GitBranchWorktreeExecutionHandoffInput,
) -> GitBranchWorktreeExecutionHandoffSet {
    let mut handoffs = input
        .preflights
        .preflights
        .into_iter()
        .map(handoff_record)
        .collect::<Vec<_>>();
    handoffs.sort_by(|left, right| left.handoff_id.cmp(&right.handoff_id));

    GitBranchWorktreeExecutionHandoffSet {
        handoff_set_id: "git-branch-worktree-execution-handoff".to_owned(),
        skipped_preflight_ids: handoffs
            .iter()
            .filter(|handoff| handoff.status != GitBranchWorktreeExecutionHandoffStatus::Admitted)
            .map(|handoff| handoff.preflight_id.clone())
            .collect(),
        handoffs,
        shell_handoff_created: false,
        checkout_executed: false,
        branch_created: false,
        worktree_created: false,
        commit_created: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

fn handoff_record(
    preflight: GitBranchWorktreePreflightRecord,
) -> GitBranchWorktreeExecutionHandoffRecord {
    let blockers = blockers(&preflight);
    let status = if blockers.is_empty() {
        GitBranchWorktreeExecutionHandoffStatus::Admitted
    } else {
        GitBranchWorktreeExecutionHandoffStatus::Blocked
    };
    let runner_handoff_admitted = status == GitBranchWorktreeExecutionHandoffStatus::Admitted;

    GitBranchWorktreeExecutionHandoffRecord {
        handoff_id: format!(
            "git-branch-worktree-execution-handoff:{}",
            preflight.preflight_id
        ),
        preflight_id: preflight.preflight_id,
        descriptor_id: preflight.descriptor_id,
        admission_id: preflight.admission_id,
        dry_run_evidence_id: preflight.dry_run_evidence_id,
        dry_run_outcome_id: preflight.dry_run_outcome_id,
        dry_run_handoff_id: preflight.dry_run_handoff_id,
        request_id: preflight.request_id,
        authority_id: preflight.authority_id,
        git_plan_id: preflight.git_plan_id,
        task_id: preflight.task_id,
        repo_id: preflight.repo_id,
        operator_ref: preflight.operator_ref,
        worktree_mode: preflight.worktree_mode,
        status,
        blockers,
        runner_handoff_admitted,
        shell_handoff_created: false,
        checkout_executed: false,
        branch_created: false,
        worktree_created: false,
        commit_created: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

fn blockers(
    preflight: &GitBranchWorktreePreflightRecord,
) -> Vec<GitBranchWorktreeExecutionHandoffBlocker> {
    let mut blockers = Vec::new();
    if preflight.status != GitBranchWorktreePreflightStatus::Ready {
        blockers.push(GitBranchWorktreeExecutionHandoffBlocker::PreflightNotReady);
    }
    blockers
}

#[cfg(test)]
mod tests;
