use crate::provider_no_effects::{ProviderNoEffects, ProviderRuntimeNoEffects};
use crate::{ForgePullRequestRefreshPersistenceRecord, ForgePullRequestRefreshStatus};

use super::types::{
    ForgePullRequestRefreshPersistenceControlDto, ForgePullRequestRefreshPersistenceDiagnostics,
    ForgePullRequestRefreshPersistenceStatus,
};

pub fn forge_pull_request_refresh_diagnostics_from_persisted_records(
    records: Vec<ForgePullRequestRefreshPersistenceRecord>,
) -> ForgePullRequestRefreshPersistenceDiagnostics {
    ForgePullRequestRefreshPersistenceDiagnostics {
        diagnostics_id: "forge-pull-request-refresh-persistence-diagnostics".to_owned(),
        refresh_count: records.len(),
        persisted_count: persistence_count(
            &records,
            ForgePullRequestRefreshPersistenceStatus::Persisted,
        ),
        duplicate_noop_count: persistence_count(
            &records,
            ForgePullRequestRefreshPersistenceStatus::DuplicateNoop,
        ),
        persistence_blocked_count: persistence_count(
            &records,
            ForgePullRequestRefreshPersistenceStatus::Blocked,
        ),
        ready_refresh_count: refresh_count(
            &records,
            ForgePullRequestRefreshStatus::ReadyForStoppedRefresh,
        ),
        repair_required_refresh_count: refresh_count(
            &records,
            ForgePullRequestRefreshStatus::RepairRequired,
        ),
        blocked_refresh_count: refresh_count(&records, ForgePullRequestRefreshStatus::Blocked),
        blocker_count: records
            .iter()
            .map(|record| record.refresh_blockers.len() + record.persistence_blockers.len())
            .sum(),
        evidence_ref_count: records
            .iter()
            .map(|record| record.evidence_refs.len())
            .sum(),
        no_effects: ProviderRuntimeNoEffects::none(),
    }
}

pub fn forge_pull_request_refresh_control_dto_from_diagnostics(
    diagnostics: ForgePullRequestRefreshPersistenceDiagnostics,
) -> ForgePullRequestRefreshPersistenceControlDto {
    ForgePullRequestRefreshPersistenceControlDto {
        dto_id: "forge-pull-request-refresh-persistence-control-dto".to_owned(),
        diagnostics_id: diagnostics.diagnostics_id,
        refresh_count: diagnostics.refresh_count,
        persisted_count: diagnostics.persisted_count,
        duplicate_noop_count: diagnostics.duplicate_noop_count,
        persistence_blocked_count: diagnostics.persistence_blocked_count,
        ready_refresh_count: diagnostics.ready_refresh_count,
        repair_required_refresh_count: diagnostics.repair_required_refresh_count,
        blocked_refresh_count: diagnostics.blocked_refresh_count,
        blocker_count: diagnostics.blocker_count,
        evidence_ref_count: diagnostics.evidence_ref_count,
        no_effects: ProviderRuntimeNoEffects::none(),
    }
}

fn persistence_count(
    records: &[ForgePullRequestRefreshPersistenceRecord],
    status: ForgePullRequestRefreshPersistenceStatus,
) -> usize {
    records
        .iter()
        .filter(|record| record.persistence_status == status)
        .count()
}

fn refresh_count(
    records: &[ForgePullRequestRefreshPersistenceRecord],
    status: ForgePullRequestRefreshStatus,
) -> usize {
    records
        .iter()
        .filter(|record| record.refresh_status == status)
        .count()
}
