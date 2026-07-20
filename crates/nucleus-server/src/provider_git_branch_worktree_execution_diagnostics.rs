//! Read-only diagnostics for Git branch/worktree execution handoff records.

use crate::provider_no_effects::ForgeScmNoEffects;
use serde::{Deserialize, Serialize};

use crate::{
    GitBranchWorktreeEvidenceSet, GitBranchWorktreeEvidenceStatus,
    GitBranchWorktreeExecutionHandoffSet, GitBranchWorktreeExecutionHandoffStatus,
    GitBranchWorktreeMode, GitBranchWorktreeOutcomeStatus, GitBranchWorktreeSanitizedOutcomeSet,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBranchWorktreeExecutionDiagnosticsInput {
    pub handoffs: GitBranchWorktreeExecutionHandoffSet,
    pub outcomes: GitBranchWorktreeSanitizedOutcomeSet,
    pub evidence: GitBranchWorktreeEvidenceSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitBranchWorktreeExecutionDiagnosticsRecord {
    pub diagnostics_id: String,
    pub handoff_count: usize,
    pub handoff_admitted_count: usize,
    pub outcome_count: usize,
    pub outcome_completed_count: usize,
    pub outcome_failed_count: usize,
    pub outcome_timed_out_count: usize,
    pub outcome_cleanup_required_count: usize,
    pub outcome_blocked_count: usize,
    pub evidence_count: usize,
    pub evidence_reviewable_count: usize,
    pub evidence_failed_count: usize,
    pub evidence_cleanup_required_count: usize,
    pub evidence_blocked_count: usize,
    pub primary_tree_count: usize,
    pub isolated_worktree_count: usize,
    pub blocker_count: usize,
    pub shell_execution_performed: bool,
    pub checkout_executed: bool,
    pub branch_created: bool,
    pub worktree_created: bool,
    pub commit_created: bool,
    pub push_executed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

pub fn git_branch_worktree_execution_diagnostics(
    input: GitBranchWorktreeExecutionDiagnosticsInput,
) -> GitBranchWorktreeExecutionDiagnosticsRecord {
    GitBranchWorktreeExecutionDiagnosticsRecord {
        diagnostics_id: "git-branch-worktree-execution-diagnostics".to_owned(),
        handoff_count: input.handoffs.handoffs.len(),
        handoff_admitted_count: input
            .handoffs
            .handoffs
            .iter()
            .filter(|handoff| handoff.status == GitBranchWorktreeExecutionHandoffStatus::Admitted)
            .count(),
        outcome_count: input.outcomes.outcomes.len(),
        outcome_completed_count: count_outcomes(
            &input.outcomes,
            GitBranchWorktreeOutcomeStatus::Completed,
        ),
        outcome_failed_count: count_outcomes(
            &input.outcomes,
            GitBranchWorktreeOutcomeStatus::Failed,
        ),
        outcome_timed_out_count: count_outcomes(
            &input.outcomes,
            GitBranchWorktreeOutcomeStatus::TimedOut,
        ),
        outcome_cleanup_required_count: count_outcomes(
            &input.outcomes,
            GitBranchWorktreeOutcomeStatus::CleanupRequired,
        ),
        outcome_blocked_count: count_outcomes(
            &input.outcomes,
            GitBranchWorktreeOutcomeStatus::Blocked,
        ),
        evidence_count: input.evidence.evidence.len(),
        evidence_reviewable_count: count_evidence(
            &input.evidence,
            GitBranchWorktreeEvidenceStatus::Reviewable,
        ),
        evidence_failed_count: count_evidence(
            &input.evidence,
            GitBranchWorktreeEvidenceStatus::Failed,
        ),
        evidence_cleanup_required_count: count_evidence(
            &input.evidence,
            GitBranchWorktreeEvidenceStatus::CleanupRequired,
        ),
        evidence_blocked_count: count_evidence(
            &input.evidence,
            GitBranchWorktreeEvidenceStatus::Blocked,
        ),
        primary_tree_count: input
            .handoffs
            .handoffs
            .iter()
            .filter(|handoff| handoff.worktree_mode == GitBranchWorktreeMode::PrimaryTree)
            .count(),
        isolated_worktree_count: input
            .handoffs
            .handoffs
            .iter()
            .filter(|handoff| handoff.worktree_mode == GitBranchWorktreeMode::IsolatedWorktree)
            .count(),
        blocker_count: input
            .handoffs
            .handoffs
            .iter()
            .map(|handoff| handoff.blockers.len())
            .sum::<usize>()
            + input
                .outcomes
                .outcomes
                .iter()
                .map(|outcome| outcome.blockers.len())
                .sum::<usize>()
            + input
                .evidence
                .evidence
                .iter()
                .map(|evidence| evidence.blockers.len())
                .sum::<usize>(),
        shell_execution_performed: false,
        checkout_executed: false,
        branch_created: false,
        worktree_created: false,
        commit_created: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

fn count_outcomes(
    outcomes: &GitBranchWorktreeSanitizedOutcomeSet,
    status: GitBranchWorktreeOutcomeStatus,
) -> usize {
    outcomes
        .outcomes
        .iter()
        .filter(|outcome| outcome.status == status)
        .count()
}

fn count_evidence(
    evidence: &GitBranchWorktreeEvidenceSet,
    status: GitBranchWorktreeEvidenceStatus,
) -> usize {
    evidence
        .evidence
        .iter()
        .filter(|record| record.status == status)
        .count()
}

#[cfg(test)]
mod tests;
