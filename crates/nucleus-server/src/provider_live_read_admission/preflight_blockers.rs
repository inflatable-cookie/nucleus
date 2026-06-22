use super::types::{
    ProviderLiveReadAdmissionRecord, ProviderLiveReadAdmissionStatus,
    ProviderLiveReadPreflightBlocker, ProviderLiveReadPreflightInput,
    ProviderLiveReadPreflightStatus,
};

pub(super) fn blockers(
    input: &ProviderLiveReadPreflightInput,
    admission: &ProviderLiveReadAdmissionRecord,
) -> Vec<ProviderLiveReadPreflightBlocker> {
    let mut blockers = Vec::new();
    if admission.status != ProviderLiveReadAdmissionStatus::ReadyForFixturePreflight {
        blockers.push(ProviderLiveReadPreflightBlocker::AdmissionNotReady);
    }
    required_ref_blockers(input, admission, &mut blockers);
    forbidden_blockers(input, &mut blockers);
    blockers
}

pub(super) fn status(
    blockers: &[ProviderLiveReadPreflightBlocker],
) -> ProviderLiveReadPreflightStatus {
    if blockers.is_empty() {
        ProviderLiveReadPreflightStatus::ReadyForRequestReceiptPlanning
    } else if blockers.iter().any(blocking_blocker) {
        ProviderLiveReadPreflightStatus::Blocked
    } else {
        ProviderLiveReadPreflightStatus::RepairRequired
    }
}

fn required_ref_blockers(
    input: &ProviderLiveReadPreflightInput,
    admission: &ProviderLiveReadAdmissionRecord,
    blockers: &mut Vec<ProviderLiveReadPreflightBlocker>,
) {
    if admission.credential_status_evidence_refs.is_empty() {
        blockers.push(ProviderLiveReadPreflightBlocker::MissingCredentialStatusEvidenceRef);
    }
    if is_empty_ref(admission.network_authority_ref.as_deref()) {
        blockers.push(ProviderLiveReadPreflightBlocker::MissingNetworkAuthorityRef);
    }
    if is_empty_ref(input.endpoint_ref.as_deref()) {
        blockers.push(ProviderLiveReadPreflightBlocker::MissingEndpointRef);
    }
    if is_empty_ref(admission.payload_policy_ref.as_deref()) {
        blockers.push(ProviderLiveReadPreflightBlocker::MissingPayloadPolicyRef);
    }
    if is_empty_ref(input.idempotency_ref.as_deref()) {
        blockers.push(ProviderLiveReadPreflightBlocker::MissingIdempotencyRef);
    }
    if is_empty_ref(admission.sanitization_policy_ref.as_deref()) {
        blockers.push(ProviderLiveReadPreflightBlocker::MissingSanitizationPolicyRef);
    }
    if is_empty_ref(input.preflight_evidence_ref.as_deref()) {
        blockers.push(ProviderLiveReadPreflightBlocker::MissingPreflightEvidenceRef);
    }
}

fn forbidden_blockers(
    input: &ProviderLiveReadPreflightInput,
    blockers: &mut Vec<ProviderLiveReadPreflightBlocker>,
) {
    if input.credential_material_present {
        blockers.push(ProviderLiveReadPreflightBlocker::CredentialMaterialPresent);
    }
    if input.provider_payload_present {
        blockers.push(ProviderLiveReadPreflightBlocker::ProviderPayloadPresent);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(ProviderLiveReadPreflightBlocker::RawProviderPayloadRetentionRequested);
    }
    if input.real_credential_resolution_requested {
        blockers.push(ProviderLiveReadPreflightBlocker::RealCredentialResolutionRequested);
    }
    if input.provider_network_call_requested {
        blockers.push(ProviderLiveReadPreflightBlocker::ProviderNetworkCallRequested);
    }
    if input.provider_write_requested {
        blockers.push(ProviderLiveReadPreflightBlocker::ProviderWriteRequested);
    }
    if input.callback_execution_requested {
        blockers.push(ProviderLiveReadPreflightBlocker::CallbackExecutionRequested);
    }
    if input.interruption_execution_requested {
        blockers.push(ProviderLiveReadPreflightBlocker::InterruptionExecutionRequested);
    }
    if input.recovery_execution_requested {
        blockers.push(ProviderLiveReadPreflightBlocker::RecoveryExecutionRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ProviderLiveReadPreflightBlocker::TaskMutationRequested);
    }
}

fn blocking_blocker(blocker: &ProviderLiveReadPreflightBlocker) -> bool {
    matches!(
        blocker,
        ProviderLiveReadPreflightBlocker::AdmissionNotReady
            | ProviderLiveReadPreflightBlocker::CredentialMaterialPresent
            | ProviderLiveReadPreflightBlocker::ProviderPayloadPresent
            | ProviderLiveReadPreflightBlocker::RawProviderPayloadRetentionRequested
            | ProviderLiveReadPreflightBlocker::RealCredentialResolutionRequested
            | ProviderLiveReadPreflightBlocker::ProviderNetworkCallRequested
            | ProviderLiveReadPreflightBlocker::ProviderWriteRequested
            | ProviderLiveReadPreflightBlocker::CallbackExecutionRequested
            | ProviderLiveReadPreflightBlocker::InterruptionExecutionRequested
            | ProviderLiveReadPreflightBlocker::RecoveryExecutionRequested
            | ProviderLiveReadPreflightBlocker::TaskMutationRequested
    )
}

fn is_empty_ref(value: Option<&str>) -> bool {
    value.unwrap_or_default().is_empty()
}
