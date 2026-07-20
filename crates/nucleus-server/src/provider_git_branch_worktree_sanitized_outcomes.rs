//! Sanitized outcome records for Git branch/worktree execution handoffs.

use crate::provider_no_effects::ForgeScmNoEffects;
use serde::{Deserialize, Serialize};

use crate::{
    GitBranchWorktreeExecutionHandoffRecord, GitBranchWorktreeExecutionHandoffSet,
    GitBranchWorktreeExecutionHandoffStatus, GitBranchWorktreeMode,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBranchWorktreeSanitizedOutcomesInput {
    pub handoffs: GitBranchWorktreeExecutionHandoffSet,
    pub requested_status: GitBranchWorktreeOutcomeStatus,
    pub inspected_path_count: usize,
    pub affected_path_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitBranchWorktreeSanitizedOutcomeSet {
    pub outcome_set_id: String,
    pub outcomes: Vec<GitBranchWorktreeSanitizedOutcomeRecord>,
    pub skipped_handoff_ids: Vec<String>,
    pub shell_execution_performed: bool,
    pub checkout_executed: bool,
    pub branch_created: bool,
    pub worktree_created: bool,
    pub commit_created: bool,
    pub push_executed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitBranchWorktreeSanitizedOutcomeRecord {
    pub outcome_id: String,
    pub execution_handoff_id: String,
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
    pub status: GitBranchWorktreeOutcomeStatus,
    pub blockers: Vec<GitBranchWorktreeOutcomeBlocker>,
    pub inspected_path_count: usize,
    pub affected_path_count: usize,
    pub shell_execution_performed: bool,
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
pub enum GitBranchWorktreeOutcomeStatus {
    Completed,
    Failed,
    TimedOut,
    CleanupRequired,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeOutcomeBlocker {
    HandoffNotAdmitted,
}

pub fn git_branch_worktree_sanitized_outcomes(
    input: GitBranchWorktreeSanitizedOutcomesInput,
) -> GitBranchWorktreeSanitizedOutcomeSet {
    let summary = GitBranchWorktreeOutcomeSummary {
        requested_status: input.requested_status,
        inspected_path_count: input.inspected_path_count,
        affected_path_count: input.affected_path_count,
    };
    let mut outcomes = input
        .handoffs
        .handoffs
        .into_iter()
        .map(|handoff| outcome_record(&summary, handoff))
        .collect::<Vec<_>>();
    outcomes.sort_by(|left, right| left.outcome_id.cmp(&right.outcome_id));

    GitBranchWorktreeSanitizedOutcomeSet {
        outcome_set_id: "git-branch-worktree-sanitized-outcomes".to_owned(),
        skipped_handoff_ids: outcomes
            .iter()
            .filter(|outcome| outcome.status == GitBranchWorktreeOutcomeStatus::Blocked)
            .map(|outcome| outcome.execution_handoff_id.clone())
            .collect(),
        outcomes,
        shell_execution_performed: false,
        checkout_executed: false,
        branch_created: false,
        worktree_created: false,
        commit_created: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GitBranchWorktreeOutcomeSummary {
    requested_status: GitBranchWorktreeOutcomeStatus,
    inspected_path_count: usize,
    affected_path_count: usize,
}

fn outcome_record(
    summary: &GitBranchWorktreeOutcomeSummary,
    handoff: GitBranchWorktreeExecutionHandoffRecord,
) -> GitBranchWorktreeSanitizedOutcomeRecord {
    let blockers = blockers(&handoff);
    let status = if blockers.is_empty() {
        summary.requested_status.clone()
    } else {
        GitBranchWorktreeOutcomeStatus::Blocked
    };

    GitBranchWorktreeSanitizedOutcomeRecord {
        outcome_id: format!("git-branch-worktree-outcome:{}", handoff.handoff_id),
        execution_handoff_id: handoff.handoff_id,
        preflight_id: handoff.preflight_id,
        descriptor_id: handoff.descriptor_id,
        admission_id: handoff.admission_id,
        dry_run_evidence_id: handoff.dry_run_evidence_id,
        dry_run_outcome_id: handoff.dry_run_outcome_id,
        dry_run_handoff_id: handoff.dry_run_handoff_id,
        request_id: handoff.request_id,
        authority_id: handoff.authority_id,
        git_plan_id: handoff.git_plan_id,
        task_id: handoff.task_id,
        repo_id: handoff.repo_id,
        operator_ref: handoff.operator_ref,
        worktree_mode: handoff.worktree_mode,
        status,
        blockers,
        inspected_path_count: summary.inspected_path_count,
        affected_path_count: summary.affected_path_count,
        shell_execution_performed: false,
        checkout_executed: false,
        branch_created: false,
        worktree_created: false,
        commit_created: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

fn blockers(
    handoff: &GitBranchWorktreeExecutionHandoffRecord,
) -> Vec<GitBranchWorktreeOutcomeBlocker> {
    let mut blockers = Vec::new();
    if handoff.status != GitBranchWorktreeExecutionHandoffStatus::Admitted {
        blockers.push(GitBranchWorktreeOutcomeBlocker::HandoffNotAdmitted);
    }
    blockers
}

#[cfg(test)]
mod tests;
