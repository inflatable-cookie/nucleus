use crate::provider_no_effects::ProviderNoEffects;
use super::{
    ProviderLiveReadPersistenceBlocker, ProviderLiveReadPersistenceInput,
    ProviderLiveReadPersistenceRecord, ProviderLiveReadPersistenceStatus,
    ProviderLiveReadRequestReceiptRecord,
};

pub(super) fn persisted_live_read_id(execution_request_id: &str) -> String {
    format!("provider-live-read-persistence:{execution_request_id}")
}

pub(super) fn persistence_record(
    input: &ProviderLiveReadPersistenceInput,
    request: ProviderLiveReadRequestReceiptRecord,
    persisted_live_read_id: String,
    duplicate: bool,
    blockers: Vec<ProviderLiveReadPersistenceBlocker>,
) -> ProviderLiveReadPersistenceRecord {
    let persistence_status = if duplicate {
        ProviderLiveReadPersistenceStatus::DuplicateNoop
    } else if blockers.is_empty() {
        ProviderLiveReadPersistenceStatus::Persisted
    } else {
        ProviderLiveReadPersistenceStatus::Blocked
    };

    let mut evidence_refs = request.evidence_refs.clone();
    evidence_refs.extend(input.persistence_evidence_refs.clone());
    evidence_refs.sort();
    evidence_refs.dedup();

    ProviderLiveReadPersistenceRecord {
        persisted_live_read_id,
        execution_request_id: request.execution_request_id,
        preflight_id: request.preflight_id,
        admission_id: request.admission_id,
        provider_context_ref: request.provider_context_ref,
        operation_family: request.operation_family,
        target_refs: request.target_refs,
        idempotency_ref: request.idempotency_ref,
        request_ref: request.request_ref,
        planned_receipt_ref: request.planned_receipt_ref,
        request_evidence_ref: request.request_evidence_ref,
        request_status: request.status,
        request_blockers: request.blockers,
        persistence_status,
        persistence_blockers: blockers,
        duplicate_request_detected: request.duplicate_request_detected,
        duplicate_live_read_detected: duplicate,
        evidence_refs,
        planned_request_recorded: request.planned_request_recorded,
        live_read_record_persisted: !duplicate
            && persistence_status == ProviderLiveReadPersistenceStatus::Persisted,
        no_effects: ProviderNoEffects::none(),
    }
}
