use crate::{ForgeStatusCheckRefreshPersistenceRecord, ForgeStatusCheckRefreshStatus};

use super::types::{
    ForgeStatusCheckRefreshPersistenceControlDto, ForgeStatusCheckRefreshPersistenceDiagnostics,
    ForgeStatusCheckRefreshPersistenceStatus,
};

pub fn forge_status_check_refresh_diagnostics_from_persisted_records(
    records: Vec<ForgeStatusCheckRefreshPersistenceRecord>,
) -> ForgeStatusCheckRefreshPersistenceDiagnostics {
    ForgeStatusCheckRefreshPersistenceDiagnostics {
        diagnostics_id: "forge-status-check-refresh-persistence-diagnostics".to_owned(),
        refresh_count: records.len(),
        persisted_count: persistence_count(
            &records,
            ForgeStatusCheckRefreshPersistenceStatus::Persisted,
        ),
        duplicate_noop_count: persistence_count(
            &records,
            ForgeStatusCheckRefreshPersistenceStatus::DuplicateNoop,
        ),
        persistence_blocked_count: persistence_count(
            &records,
            ForgeStatusCheckRefreshPersistenceStatus::Blocked,
        ),
        ready_refresh_count: refresh_count(
            &records,
            ForgeStatusCheckRefreshStatus::ReadyForStoppedRefresh,
        ),
        repair_required_refresh_count: refresh_count(
            &records,
            ForgeStatusCheckRefreshStatus::RepairRequired,
        ),
        blocked_refresh_count: refresh_count(&records, ForgeStatusCheckRefreshStatus::Blocked),
        blocker_count: records
            .iter()
            .map(|record| record.refresh_blockers.len() + record.persistence_blockers.len())
            .sum(),
        evidence_ref_count: records
            .iter()
            .map(|record| record.evidence_refs.len())
            .sum(),
        credential_resolution_performed: false,
        provider_network_call_performed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

pub fn forge_status_check_refresh_control_dto_from_diagnostics(
    diagnostics: ForgeStatusCheckRefreshPersistenceDiagnostics,
) -> ForgeStatusCheckRefreshPersistenceControlDto {
    ForgeStatusCheckRefreshPersistenceControlDto {
        dto_id: "forge-status-check-refresh-persistence-control-dto".to_owned(),
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
        credential_resolution_performed: false,
        provider_network_call_performed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn persistence_count(
    records: &[ForgeStatusCheckRefreshPersistenceRecord],
    status: ForgeStatusCheckRefreshPersistenceStatus,
) -> usize {
    records
        .iter()
        .filter(|record| record.persistence_status == status)
        .count()
}

fn refresh_count(
    records: &[ForgeStatusCheckRefreshPersistenceRecord],
    status: ForgeStatusCheckRefreshStatus,
) -> usize {
    records
        .iter()
        .filter(|record| record.refresh_status == status)
        .count()
}
