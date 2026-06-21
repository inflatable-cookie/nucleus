//! Reviewable evidence records for Git branch/worktree execution outcomes.

use serde::{Deserialize, Serialize};

use crate::{
    GitBranchWorktreeMode, GitBranchWorktreeOutcomeStatus, GitBranchWorktreeSanitizedOutcomeRecord,
    GitBranchWorktreeSanitizedOutcomeSet,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBranchWorktreeEvidenceInput {
    pub outcomes: GitBranchWorktreeSanitizedOutcomeSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitBranchWorktreeEvidenceSet {
    pub evidence_set_id: String,
    pub evidence: Vec<GitBranchWorktreeEvidenceRecord>,
    pub skipped_outcome_ids: Vec<String>,
    pub commit_readiness_granted: bool,
    pub push_readiness_granted: bool,
    pub pull_request_readiness_granted: bool,
    pub raw_output_retained: bool,
    pub git_effect_executed: bool,
    pub forge_effect_executed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitBranchWorktreeEvidenceRecord {
    pub evidence_id: String,
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
    pub status: GitBranchWorktreeEvidenceStatus,
    pub blockers: Vec<GitBranchWorktreeEvidenceBlocker>,
    pub inspected_path_count: usize,
    pub affected_path_count: usize,
    pub commit_readiness_granted: bool,
    pub push_readiness_granted: bool,
    pub pull_request_readiness_granted: bool,
    pub raw_output_retained: bool,
    pub git_effect_executed: bool,
    pub forge_effect_executed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeEvidenceStatus {
    Reviewable,
    Failed,
    TimedOut,
    CleanupRequired,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeEvidenceBlocker {
    OutcomeNotCompleted,
    HandoffNotAdmitted,
    CleanupRequired,
}

pub fn git_branch_worktree_evidence(
    input: GitBranchWorktreeEvidenceInput,
) -> GitBranchWorktreeEvidenceSet {
    let mut evidence = input
        .outcomes
        .outcomes
        .into_iter()
        .map(evidence_record)
        .collect::<Vec<_>>();
    evidence.sort_by(|left, right| left.evidence_id.cmp(&right.evidence_id));

    GitBranchWorktreeEvidenceSet {
        evidence_set_id: "git-branch-worktree-evidence".to_owned(),
        skipped_outcome_ids: evidence
            .iter()
            .filter(|record| record.status != GitBranchWorktreeEvidenceStatus::Reviewable)
            .map(|record| record.outcome_id.clone())
            .collect(),
        evidence,
        commit_readiness_granted: false,
        push_readiness_granted: false,
        pull_request_readiness_granted: false,
        raw_output_retained: false,
        git_effect_executed: false,
        forge_effect_executed: false,
    }
}

fn evidence_record(
    outcome: GitBranchWorktreeSanitizedOutcomeRecord,
) -> GitBranchWorktreeEvidenceRecord {
    let blockers = blockers(&outcome);
    let status = status(&outcome, &blockers);

    GitBranchWorktreeEvidenceRecord {
        evidence_id: format!("git-branch-worktree-evidence:{}", outcome.outcome_id),
        outcome_id: outcome.outcome_id,
        execution_handoff_id: outcome.execution_handoff_id,
        preflight_id: outcome.preflight_id,
        descriptor_id: outcome.descriptor_id,
        admission_id: outcome.admission_id,
        dry_run_evidence_id: outcome.dry_run_evidence_id,
        dry_run_outcome_id: outcome.dry_run_outcome_id,
        dry_run_handoff_id: outcome.dry_run_handoff_id,
        request_id: outcome.request_id,
        authority_id: outcome.authority_id,
        git_plan_id: outcome.git_plan_id,
        task_id: outcome.task_id,
        repo_id: outcome.repo_id,
        operator_ref: outcome.operator_ref,
        worktree_mode: outcome.worktree_mode,
        status,
        blockers,
        inspected_path_count: outcome.inspected_path_count,
        affected_path_count: outcome.affected_path_count,
        commit_readiness_granted: false,
        push_readiness_granted: false,
        pull_request_readiness_granted: false,
        raw_output_retained: false,
        git_effect_executed: false,
        forge_effect_executed: false,
    }
}

fn status(
    outcome: &GitBranchWorktreeSanitizedOutcomeRecord,
    blockers: &[GitBranchWorktreeEvidenceBlocker],
) -> GitBranchWorktreeEvidenceStatus {
    if blockers
        .iter()
        .any(|blocker| blocker == &GitBranchWorktreeEvidenceBlocker::HandoffNotAdmitted)
    {
        return GitBranchWorktreeEvidenceStatus::Blocked;
    }

    match outcome.status {
        GitBranchWorktreeOutcomeStatus::Completed => GitBranchWorktreeEvidenceStatus::Reviewable,
        GitBranchWorktreeOutcomeStatus::Failed => GitBranchWorktreeEvidenceStatus::Failed,
        GitBranchWorktreeOutcomeStatus::TimedOut => GitBranchWorktreeEvidenceStatus::TimedOut,
        GitBranchWorktreeOutcomeStatus::CleanupRequired => {
            GitBranchWorktreeEvidenceStatus::CleanupRequired
        }
        GitBranchWorktreeOutcomeStatus::Blocked => GitBranchWorktreeEvidenceStatus::Blocked,
    }
}

fn blockers(
    outcome: &GitBranchWorktreeSanitizedOutcomeRecord,
) -> Vec<GitBranchWorktreeEvidenceBlocker> {
    let mut blockers = Vec::new();
    if outcome.status == GitBranchWorktreeOutcomeStatus::Blocked {
        blockers.push(GitBranchWorktreeEvidenceBlocker::HandoffNotAdmitted);
    } else if outcome.status == GitBranchWorktreeOutcomeStatus::CleanupRequired {
        blockers.push(GitBranchWorktreeEvidenceBlocker::CleanupRequired);
    } else if outcome.status != GitBranchWorktreeOutcomeStatus::Completed {
        blockers.push(GitBranchWorktreeEvidenceBlocker::OutcomeNotCompleted);
    }
    blockers
}

#[cfg(test)]
mod tests;
