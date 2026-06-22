use crate::ForgePullRequestRunnerOutcomePersistenceRecord;

use super::types::{
    ForgePullRequestRunnerOutcomeDiagnosticsRecord, ForgePullRequestRunnerOutcomePersistenceStatus,
    ForgePullRequestRunnerOutcomeStatus,
};

pub fn forge_pull_request_runner_outcome_diagnostics_from_persisted_records(
    records: Vec<ForgePullRequestRunnerOutcomePersistenceRecord>,
) -> ForgePullRequestRunnerOutcomeDiagnosticsRecord {
    ForgePullRequestRunnerOutcomeDiagnosticsRecord {
        diagnostics_id: "forge-pull-request-runner-outcome-diagnostics".to_owned(),
        outcome_count: records.len(),
        completed_count: outcome_count(&records, ForgePullRequestRunnerOutcomeStatus::Completed),
        failed_count: outcome_count(&records, ForgePullRequestRunnerOutcomeStatus::Failed),
        blocked_count: outcome_count(&records, ForgePullRequestRunnerOutcomeStatus::Blocked),
        repair_required_count: outcome_count(
            &records,
            ForgePullRequestRunnerOutcomeStatus::RepairRequired,
        ),
        duplicate_noop_count: outcome_count(
            &records,
            ForgePullRequestRunnerOutcomeStatus::DuplicateNoop,
        ),
        persistence_blocked_count: records
            .iter()
            .filter(|record| {
                record.persistence_status == ForgePullRequestRunnerOutcomePersistenceStatus::Blocked
            })
            .count(),
        blocker_count: records
            .iter()
            .map(|record| record.request_blockers.len() + record.persistence_blockers.len())
            .sum(),
        provider_request_prepared_count: records
            .iter()
            .filter(|record| record.provider_request_prepared)
            .count(),
        evidence_ref_count: records
            .iter()
            .map(|record| record.evidence_refs.len())
            .sum(),
        shell_execution_performed: false,
        pull_request_created: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_output_retained: false,
    }
}

fn outcome_count(
    records: &[ForgePullRequestRunnerOutcomePersistenceRecord],
    status: ForgePullRequestRunnerOutcomeStatus,
) -> usize {
    records
        .iter()
        .filter(|record| record.outcome_status == status)
        .count()
}
