use crate::{
    ForgeCredentialStatusClass, ForgeCredentialStatusRefreshPersistenceRecord,
    ForgeCredentialStatusRefreshStatus,
};

use super::types::{
    ForgeCredentialStatusRefreshPersistenceControlDto,
    ForgeCredentialStatusRefreshPersistenceDiagnostics,
    ForgeCredentialStatusRefreshPersistenceStatus,
};

pub fn forge_credential_status_refresh_diagnostics_from_persisted_records(
    records: Vec<ForgeCredentialStatusRefreshPersistenceRecord>,
) -> ForgeCredentialStatusRefreshPersistenceDiagnostics {
    ForgeCredentialStatusRefreshPersistenceDiagnostics {
        diagnostics_id: "forge-credential-status-refresh-persistence-diagnostics".to_owned(),
        refresh_count: records.len(),
        persisted_count: persistence_count(
            &records,
            ForgeCredentialStatusRefreshPersistenceStatus::Persisted,
        ),
        duplicate_noop_count: persistence_count(
            &records,
            ForgeCredentialStatusRefreshPersistenceStatus::DuplicateNoop,
        ),
        persistence_blocked_count: persistence_count(
            &records,
            ForgeCredentialStatusRefreshPersistenceStatus::Blocked,
        ),
        ready_refresh_count: refresh_count(
            &records,
            ForgeCredentialStatusRefreshStatus::ReadyForStoppedRefresh,
        ),
        repair_required_refresh_count: refresh_count(
            &records,
            ForgeCredentialStatusRefreshStatus::RepairRequired,
        ),
        blocked_refresh_count: refresh_count(&records, ForgeCredentialStatusRefreshStatus::Blocked),
        ready_credential_count: class_count(&records, ForgeCredentialStatusClass::Ready),
        repair_credential_count: class_count(&records, ForgeCredentialStatusClass::RequiresRepair),
        unknown_credential_count: class_count(&records, ForgeCredentialStatusClass::Unknown),
        unsupported_credential_count: class_count(
            &records,
            ForgeCredentialStatusClass::Unsupported,
        ),
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

pub fn forge_credential_status_refresh_control_dto_from_diagnostics(
    diagnostics: ForgeCredentialStatusRefreshPersistenceDiagnostics,
) -> ForgeCredentialStatusRefreshPersistenceControlDto {
    ForgeCredentialStatusRefreshPersistenceControlDto {
        dto_id: "forge-credential-status-refresh-persistence-control-dto".to_owned(),
        diagnostics_id: diagnostics.diagnostics_id,
        refresh_count: diagnostics.refresh_count,
        persisted_count: diagnostics.persisted_count,
        duplicate_noop_count: diagnostics.duplicate_noop_count,
        persistence_blocked_count: diagnostics.persistence_blocked_count,
        ready_refresh_count: diagnostics.ready_refresh_count,
        repair_required_refresh_count: diagnostics.repair_required_refresh_count,
        blocked_refresh_count: diagnostics.blocked_refresh_count,
        ready_credential_count: diagnostics.ready_credential_count,
        repair_credential_count: diagnostics.repair_credential_count,
        unknown_credential_count: diagnostics.unknown_credential_count,
        unsupported_credential_count: diagnostics.unsupported_credential_count,
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
    records: &[ForgeCredentialStatusRefreshPersistenceRecord],
    status: ForgeCredentialStatusRefreshPersistenceStatus,
) -> usize {
    records
        .iter()
        .filter(|record| record.persistence_status == status)
        .count()
}

fn refresh_count(
    records: &[ForgeCredentialStatusRefreshPersistenceRecord],
    status: ForgeCredentialStatusRefreshStatus,
) -> usize {
    records
        .iter()
        .filter(|record| record.refresh_status == status)
        .count()
}

fn class_count(
    records: &[ForgeCredentialStatusRefreshPersistenceRecord],
    class: ForgeCredentialStatusClass,
) -> usize {
    records
        .iter()
        .filter(|record| record.status_class == class)
        .count()
}
