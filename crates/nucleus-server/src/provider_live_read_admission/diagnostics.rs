use super::{
    ProviderLiveReadPersistenceControlDto, ProviderLiveReadPersistenceDiagnostics,
    ProviderLiveReadPersistenceRecord, ProviderLiveReadPersistenceStatus,
    ProviderLiveReadRequestReceiptStatus,
};
use crate::provider_no_effects::ProviderNoEffects;

pub fn provider_live_read_persistence_diagnostics_from_records(
    records: Vec<ProviderLiveReadPersistenceRecord>,
) -> ProviderLiveReadPersistenceDiagnostics {
    ProviderLiveReadPersistenceDiagnostics {
        diagnostics_id: "provider-live-read-persistence-diagnostics".to_owned(),
        live_read_count: records.len(),
        persisted_count: persistence_count(&records, ProviderLiveReadPersistenceStatus::Persisted),
        duplicate_noop_count: persistence_count(
            &records,
            ProviderLiveReadPersistenceStatus::DuplicateNoop,
        ),
        persistence_blocked_count: persistence_count(
            &records,
            ProviderLiveReadPersistenceStatus::Blocked,
        ),
        planned_request_count: request_count(
            &records,
            ProviderLiveReadRequestReceiptStatus::PlannedRequestRecorded,
        ),
        duplicate_request_count: request_count(
            &records,
            ProviderLiveReadRequestReceiptStatus::DuplicateNoop,
        ),
        repair_required_request_count: request_count(
            &records,
            ProviderLiveReadRequestReceiptStatus::RepairRequired,
        ),
        blocked_request_count: request_count(
            &records,
            ProviderLiveReadRequestReceiptStatus::Blocked,
        ),
        blocker_count: records
            .iter()
            .map(|record| record.request_blockers.len() + record.persistence_blockers.len())
            .sum(),
        evidence_ref_count: records
            .iter()
            .map(|record| record.evidence_refs.len())
            .sum(),
        no_effects: ProviderNoEffects::none(),
    }
}

pub fn provider_live_read_persistence_control_dto_from_diagnostics(
    diagnostics: ProviderLiveReadPersistenceDiagnostics,
) -> ProviderLiveReadPersistenceControlDto {
    ProviderLiveReadPersistenceControlDto {
        dto_id: "provider-live-read-persistence-control-dto".to_owned(),
        diagnostics_id: diagnostics.diagnostics_id,
        live_read_count: diagnostics.live_read_count,
        persisted_count: diagnostics.persisted_count,
        duplicate_noop_count: diagnostics.duplicate_noop_count,
        persistence_blocked_count: diagnostics.persistence_blocked_count,
        planned_request_count: diagnostics.planned_request_count,
        duplicate_request_count: diagnostics.duplicate_request_count,
        repair_required_request_count: diagnostics.repair_required_request_count,
        blocked_request_count: diagnostics.blocked_request_count,
        blocker_count: diagnostics.blocker_count,
        evidence_ref_count: diagnostics.evidence_ref_count,
        no_effects: ProviderNoEffects::none(),
    }
}

fn persistence_count(
    records: &[ProviderLiveReadPersistenceRecord],
    status: ProviderLiveReadPersistenceStatus,
) -> usize {
    crate::admission_gate::count_by_status(records, &status, |record| &record.persistence_status)
}

fn request_count(
    records: &[ProviderLiveReadPersistenceRecord],
    status: ProviderLiveReadRequestReceiptStatus,
) -> usize {
    crate::admission_gate::count_by_status(records, &status, |record| &record.request_status)
}
