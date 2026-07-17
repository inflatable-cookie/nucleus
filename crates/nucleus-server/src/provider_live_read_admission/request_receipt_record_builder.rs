use crate::provider_no_effects::ProviderNoEffects;
use super::request_receipt_blockers::{blockers, status};
use super::types::{
    ProviderLiveReadPreflightRecord, ProviderLiveReadRequestReceiptInput,
    ProviderLiveReadRequestReceiptRecord, ProviderLiveReadRequestReceiptStatus,
};

pub(super) fn request_receipt_record(
    input: &ProviderLiveReadRequestReceiptInput,
    preflight: ProviderLiveReadPreflightRecord,
) -> ProviderLiveReadRequestReceiptRecord {
    let execution_request_id = execution_request_id(&preflight.preflight_id);
    let duplicate_request_detected = input
        .existing_execution_request_ids
        .contains(&execution_request_id);
    let blockers = if duplicate_request_detected {
        Vec::new()
    } else {
        blockers(input, &preflight)
    };
    let status = status(&blockers, duplicate_request_detected);
    let evidence_refs = evidence_refs(input, &preflight);

    ProviderLiveReadRequestReceiptRecord {
        execution_request_id,
        preflight_id: preflight.preflight_id,
        admission_id: preflight.admission_id,
        provider_context_ref: preflight.provider_context_ref,
        operation_family: preflight.operation_family,
        target_refs: preflight.target_refs,
        idempotency_ref: preflight.idempotency_ref,
        request_ref: input.request_ref.clone(),
        planned_receipt_ref: input.planned_receipt_ref.clone(),
        request_evidence_ref: input.request_evidence_ref.clone(),
        evidence_refs,
        planned_request_recorded: status
            == ProviderLiveReadRequestReceiptStatus::PlannedRequestRecorded,
        status,
        blockers,
        duplicate_request_detected,
        no_effects: ProviderNoEffects::none(),
    }
}

fn execution_request_id(preflight_id: &str) -> String {
    format!("provider-live-read-request:{preflight_id}")
}

fn evidence_refs(
    input: &ProviderLiveReadRequestReceiptInput,
    preflight: &ProviderLiveReadPreflightRecord,
) -> Vec<String> {
    let mut refs = preflight.evidence_refs.clone();
    push_non_empty(&mut refs, input.request_ref.as_deref());
    push_non_empty(&mut refs, input.planned_receipt_ref.as_deref());
    push_non_empty(&mut refs, input.request_evidence_ref.as_deref());
    refs
}

fn push_non_empty(refs: &mut Vec<String>, value: Option<&str>) {
    if let Some(value) = value {
        if !value.is_empty() && !refs.iter().any(|existing| existing == value) {
            refs.push(value.to_owned());
        }
    }
}
