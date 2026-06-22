use super::blockers::{blockers, status};
use super::types::{
    ProviderLiveReadAdmissionInput, ProviderLiveReadAdmissionRecord,
    ProviderLiveReadAdmissionStatus,
};

pub(super) fn admission_record(
    input: &ProviderLiveReadAdmissionInput,
    provider_context_ref: String,
) -> ProviderLiveReadAdmissionRecord {
    let blockers = blockers(input, &provider_context_ref);
    let status = status(&blockers);
    let evidence_refs = evidence_refs(input);

    ProviderLiveReadAdmissionRecord {
        admission_id: format!("provider-live-read-admission:{provider_context_ref}"),
        provider_context_ref,
        provider_instance_ref: input.provider_instance_ref.clone(),
        forge_provider: input.forge_provider.clone(),
        remote_repo_ref: input.remote_repo_ref.clone(),
        operation_family: input.operation_family.clone(),
        target_refs: input
            .target_refs
            .iter()
            .filter(|target_ref| !target_ref.is_empty())
            .cloned()
            .collect(),
        credential_status_evidence_refs: input
            .credential_status_evidence_refs
            .iter()
            .filter(|evidence_ref| !evidence_ref.is_empty())
            .cloned()
            .collect(),
        network_authority_ref: input.network_authority_ref.clone(),
        payload_policy_ref: input.payload_policy_ref.clone(),
        sanitization_policy_ref: input.sanitization_policy_ref.clone(),
        admission_evidence_ref: input.admission_evidence_ref.clone(),
        evidence_refs,
        fixture_preflight_permitted: status
            == ProviderLiveReadAdmissionStatus::ReadyForFixturePreflight,
        status,
        blockers,
        credential_resolution_performed: false,
        provider_network_call_performed: false,
        provider_write_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn evidence_refs(input: &ProviderLiveReadAdmissionInput) -> Vec<String> {
    let mut refs = Vec::new();
    push_all_non_empty(&mut refs, &input.credential_status_evidence_refs);
    push_non_empty(&mut refs, input.network_authority_ref.as_deref());
    push_non_empty(&mut refs, input.payload_policy_ref.as_deref());
    push_non_empty(&mut refs, input.sanitization_policy_ref.as_deref());
    push_non_empty(&mut refs, input.admission_evidence_ref.as_deref());
    refs
}

fn push_all_non_empty(refs: &mut Vec<String>, values: &[String]) {
    for value in values {
        push_non_empty(refs, Some(value));
    }
}

fn push_non_empty(refs: &mut Vec<String>, value: Option<&str>) {
    if let Some(value) = value {
        if !value.is_empty() {
            refs.push(value.to_owned());
        }
    }
}
