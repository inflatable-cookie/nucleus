use crate::provider_no_effects::{ForgeScmNoEffects};
use crate::{GitBranchWorktreeMode, GitCommitRunnerOutcomePersistenceRecord};

use super::types::{
    GitCommitRunnerOutcomeDiagnosticsRecord, GitCommitRunnerOutcomePersistenceStatus,
    GitCommitRunnerOutcomeStatus,
};

pub fn git_commit_runner_outcome_diagnostics_from_persisted_records(
    records: Vec<GitCommitRunnerOutcomePersistenceRecord>,
) -> GitCommitRunnerOutcomeDiagnosticsRecord {
    GitCommitRunnerOutcomeDiagnosticsRecord {
        diagnostics_id: "git-commit-runner-outcome-diagnostics".to_owned(),
        outcome_count: records.len(),
        completed_count: outcome_count(&records, GitCommitRunnerOutcomeStatus::Completed),
        failed_count: outcome_count(&records, GitCommitRunnerOutcomeStatus::Failed),
        blocked_count: outcome_count(&records, GitCommitRunnerOutcomeStatus::Blocked),
        repair_required_count: outcome_count(
            &records,
            GitCommitRunnerOutcomeStatus::RepairRequired,
        ),
        duplicate_noop_count: outcome_count(&records, GitCommitRunnerOutcomeStatus::DuplicateNoop),
        persistence_blocked_count: records
            .iter()
            .filter(|record| {
                record.persistence_status == GitCommitRunnerOutcomePersistenceStatus::Blocked
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
        commit_created: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

fn outcome_count(
    records: &[GitCommitRunnerOutcomePersistenceRecord],
    status: GitCommitRunnerOutcomeStatus,
) -> usize {
    records
        .iter()
        .filter(|record| record.outcome_status == status)
        .count()
}
