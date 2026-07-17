use crate::provider_no_effects::{ForgeScmNoEffects};
use crate::{GitBranchWorktreeMode, GitBranchWorktreeRunnerOutcomePersistenceRecord};

use super::types::{
    GitBranchWorktreeRunnerOutcomeDiagnosticsRecord,
    GitBranchWorktreeRunnerOutcomePersistenceStatus, GitBranchWorktreeRunnerOutcomeStatus,
};

pub fn git_branch_worktree_runner_outcome_diagnostics_from_persisted_records(
    records: Vec<GitBranchWorktreeRunnerOutcomePersistenceRecord>,
) -> GitBranchWorktreeRunnerOutcomeDiagnosticsRecord {
    GitBranchWorktreeRunnerOutcomeDiagnosticsRecord {
        diagnostics_id: "git-branch-worktree-runner-outcome-diagnostics".to_owned(),
        outcome_count: records.len(),
        completed_count: outcome_count(&records, GitBranchWorktreeRunnerOutcomeStatus::Completed),
        failed_count: outcome_count(&records, GitBranchWorktreeRunnerOutcomeStatus::Failed),
        blocked_count: outcome_count(&records, GitBranchWorktreeRunnerOutcomeStatus::Blocked),
        repair_required_count: outcome_count(
            &records,
            GitBranchWorktreeRunnerOutcomeStatus::RepairRequired,
        ),
        duplicate_noop_count: outcome_count(
            &records,
            GitBranchWorktreeRunnerOutcomeStatus::DuplicateNoop,
        ),
        persistence_blocked_count: records
            .iter()
            .filter(|record| {
                record.persistence_status
                    == GitBranchWorktreeRunnerOutcomePersistenceStatus::Blocked
            })
            .count(),
        blocker_count: records
            .iter()
            .map(|record| record.command_blockers.len() + record.persistence_blockers.len())
            .sum(),
        primary_tree_count: records
            .iter()
            .filter(|record| record.worktree_mode == GitBranchWorktreeMode::PrimaryTree)
            .count(),
        isolated_worktree_count: records
            .iter()
            .filter(|record| record.worktree_mode == GitBranchWorktreeMode::IsolatedWorktree)
            .count(),
        evidence_ref_count: records
            .iter()
            .map(|record| record.evidence_refs.len())
            .sum(),
        shell_execution_performed: false,
        checkout_executed: false,
        branch_created: false,
        worktree_created: false,
        commit_created: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

fn outcome_count(
    records: &[GitBranchWorktreeRunnerOutcomePersistenceRecord],
    status: GitBranchWorktreeRunnerOutcomeStatus,
) -> usize {
    records
        .iter()
        .filter(|record| record.outcome_status == status)
        .count()
}
