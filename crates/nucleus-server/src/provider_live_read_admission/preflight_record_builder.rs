use crate::provider_no_effects::ProviderNoEffects;
use super::preflight_blockers::{blockers, status};
use super::types::{
    ProviderLiveReadAdmissionRecord, ProviderLiveReadPreflightInput,
    ProviderLiveReadPreflightRecord, ProviderLiveReadPreflightStatus,
};

pub(super) fn preflight_record(
    input: &ProviderLiveReadPreflightInput,
    admission: ProviderLiveReadAdmissionRecord,
) -> ProviderLiveReadPreflightRecord {
    let blockers = blockers(input, &admission);
    let status = status(&blockers);
    let evidence_refs = evidence_refs(input, &admission);

    ProviderLiveReadPreflightRecord {
        preflight_id: format!("provider-live-read-preflight:{}", admission.admission_id),
        admission_id: admission.admission_id,
        provider_context_ref: admission.provider_context_ref,
        provider_instance_ref: admission.provider_instance_ref,
        forge_provider: admission.forge_provider,
        remote_repo_ref: admission.remote_repo_ref,
        operation_family: admission.operation_family,
        target_refs: admission.target_refs,
        credential_status_evidence_refs: admission.credential_status_evidence_refs,
        network_authority_ref: admission.network_authority_ref,
        endpoint_ref: input.endpoint_ref.clone(),
        payload_policy_ref: admission.payload_policy_ref,
        idempotency_ref: input.idempotency_ref.clone(),
        sanitization_policy_ref: admission.sanitization_policy_ref,
        admission_evidence_ref: admission.admission_evidence_ref,
        preflight_evidence_ref: input.preflight_evidence_ref.clone(),
        evidence_refs,
        fixture_request_planning_permitted: status
            == ProviderLiveReadPreflightStatus::ReadyForRequestReceiptPlanning,
        status,
        blockers,
        no_effects: ProviderNoEffects::none(),
    }
}

fn evidence_refs(
    input: &ProviderLiveReadPreflightInput,
    admission: &ProviderLiveReadAdmissionRecord,
) -> Vec<String> {
    let mut refs = admission.evidence_refs.clone();
    push_non_empty(&mut refs, input.endpoint_ref.as_deref());
    push_non_empty(&mut refs, input.idempotency_ref.as_deref());
    push_non_empty(&mut refs, input.preflight_evidence_ref.as_deref());
    refs
}

fn push_non_empty(refs: &mut Vec<String>, value: Option<&str>) {
    if let Some(value) = value {
        if !value.is_empty() && !refs.iter().any(|existing| existing == value) {
            refs.push(value.to_owned());
        }
    }
}
