use crate::provider_no_effects::{ForgeScmNoEffects};
use crate::GitPushRunnerOutcomePersistenceRecord;

use super::types::{
    GitPushRunnerOutcomeDiagnosticsRecord, GitPushRunnerOutcomePersistenceStatus,
    GitPushRunnerOutcomeStatus,
};

pub fn git_push_runner_outcome_diagnostics_from_persisted_records(
    records: Vec<GitPushRunnerOutcomePersistenceRecord>,
) -> GitPushRunnerOutcomeDiagnosticsRecord {
    GitPushRunnerOutcomeDiagnosticsRecord {
        diagnostics_id: "git-push-runner-outcome-diagnostics".to_owned(),
        outcome_count: records.len(),
        completed_count: outcome_count(&records, GitPushRunnerOutcomeStatus::Completed),
        failed_count: outcome_count(&records, GitPushRunnerOutcomeStatus::Failed),
        blocked_count: outcome_count(&records, GitPushRunnerOutcomeStatus::Blocked),
        repair_required_count: outcome_count(&records, GitPushRunnerOutcomeStatus::RepairRequired),
        duplicate_noop_count: outcome_count(&records, GitPushRunnerOutcomeStatus::DuplicateNoop),
        persistence_blocked_count: records
            .iter()
            .filter(|record| {
                record.persistence_status == GitPushRunnerOutcomePersistenceStatus::Blocked
            })
            .count(),
        blocker_count: records
            .iter()
            .map(|record| record.command_blockers.len() + record.persistence_blockers.len())
            .sum(),
        remote_target_count: records
            .iter()
            .filter(|record| record.remote_target.is_some())
            .count(),
        evidence_ref_count: records
            .iter()
            .map(|record| record.evidence_refs.len())
            .sum(),
        shell_execution_performed: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

fn outcome_count(
    records: &[GitPushRunnerOutcomePersistenceRecord],
    status: GitPushRunnerOutcomeStatus,
) -> usize {
    records
        .iter()
        .filter(|record| record.outcome_status == status)
        .count()
}
