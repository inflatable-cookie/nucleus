use crate::{ForgeNetworkExecutionAdmissionRecord, ForgeNetworkExecutionAdmissionStatus};

use super::types::{
    ForgeNetworkExecutionPreflightBlocker, ForgeNetworkExecutionPreflightInput,
    ForgeNetworkExecutionPreflightRecord, ForgeNetworkExecutionPreflightStatus,
};

pub(super) fn preflight_record(
    input: &ForgeNetworkExecutionPreflightInput,
    admission: ForgeNetworkExecutionAdmissionRecord,
) -> ForgeNetworkExecutionPreflightRecord {
    let blockers = blockers(input, &admission);
    let status = status(&blockers);
    ForgeNetworkExecutionPreflightRecord::from_admission(admission, status, blockers, input)
}

fn blockers(
    input: &ForgeNetworkExecutionPreflightInput,
    admission: &ForgeNetworkExecutionAdmissionRecord,
) -> Vec<ForgeNetworkExecutionPreflightBlocker> {
    let mut blockers = Vec::new();
    if admission.status != ForgeNetworkExecutionAdmissionStatus::ReadyForStoppedPreflight
        || !admission.stopped_preflight_permitted
    {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::AdmissionNotReady);
    }
    if admission.forge_provider.is_none() {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::MissingForgeProvider);
    }
    required_ref_blockers(input, admission, &mut blockers);
    forbidden_blockers(input, &mut blockers);
    blockers
}

fn required_ref_blockers(
    input: &ForgeNetworkExecutionPreflightInput,
    admission: &ForgeNetworkExecutionAdmissionRecord,
    blockers: &mut Vec<ForgeNetworkExecutionPreflightBlocker>,
) {
    if empty(input.provider_context_ref.as_deref()) {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::MissingProviderContextRef);
    }
    if empty(input.target_provider_ref.as_deref()) {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::MissingTargetProviderRef);
    }
    if empty(input.credential_use_evidence_ref.as_deref()) {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::MissingCredentialUseEvidenceRef);
    }
    if empty(input.preflight_evidence_ref.as_deref()) {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::MissingPreflightEvidenceRef);
    }
    if empty(input.provider_response_evidence_ref.as_deref()) {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::MissingProviderResponseEvidenceRef);
    }
    if empty(admission.network_authority_ref.as_deref()) {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::MissingNetworkAuthorityRef);
    }
    if admission.operation_family.is_mutating() && empty(admission.operator_approval_ref.as_deref())
    {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::MissingOperatorApprovalRef);
    }
    if empty(admission.idempotency_key.as_deref()) {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::MissingIdempotencyKey);
    }
    if empty(admission.retry_policy_ref.as_deref()) {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::MissingRetryPolicyRef);
    }
    if empty(admission.recovery_policy_ref.as_deref()) {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::MissingRecoveryPolicyRef);
    }
    if empty(admission.sanitization_policy_ref.as_deref()) {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::MissingSanitizationPolicyRef);
    }
    if admission.operation_family.is_deferred() {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::DeferredOperationFamily);
    }
}

fn forbidden_blockers(
    input: &ForgeNetworkExecutionPreflightInput,
    blockers: &mut Vec<ForgeNetworkExecutionPreflightBlocker>,
) {
    if input.real_credential_resolution_requested {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::RealCredentialResolutionRequested);
    }
    if input.provider_network_call_requested {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::ProviderNetworkCallRequested);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::RawProviderPayloadRetentionRequested);
    }
    if input.callback_execution_requested {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::CallbackExecutionRequested);
    }
    if input.interruption_execution_requested {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::InterruptionExecutionRequested);
    }
    if input.recovery_execution_requested {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::RecoveryExecutionRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ForgeNetworkExecutionPreflightBlocker::TaskMutationRequested);
    }
}

fn status(
    blockers: &[ForgeNetworkExecutionPreflightBlocker],
) -> ForgeNetworkExecutionPreflightStatus {
    if blockers.is_empty() {
        ForgeNetworkExecutionPreflightStatus::ReadyForStoppedExecutionRequest
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ForgeNetworkExecutionPreflightBlocker::AdmissionNotReady
                | ForgeNetworkExecutionPreflightBlocker::MissingForgeProvider
                | ForgeNetworkExecutionPreflightBlocker::MissingProviderContextRef
                | ForgeNetworkExecutionPreflightBlocker::MissingTargetProviderRef
                | ForgeNetworkExecutionPreflightBlocker::MissingCredentialUseEvidenceRef
                | ForgeNetworkExecutionPreflightBlocker::MissingPreflightEvidenceRef
                | ForgeNetworkExecutionPreflightBlocker::MissingProviderResponseEvidenceRef
                | ForgeNetworkExecutionPreflightBlocker::MissingNetworkAuthorityRef
                | ForgeNetworkExecutionPreflightBlocker::MissingOperatorApprovalRef
                | ForgeNetworkExecutionPreflightBlocker::MissingIdempotencyKey
                | ForgeNetworkExecutionPreflightBlocker::MissingRetryPolicyRef
                | ForgeNetworkExecutionPreflightBlocker::MissingRecoveryPolicyRef
                | ForgeNetworkExecutionPreflightBlocker::MissingSanitizationPolicyRef
        )
    }) {
        ForgeNetworkExecutionPreflightStatus::RepairRequired
    } else {
        ForgeNetworkExecutionPreflightStatus::Blocked
    }
}

fn empty(value: Option<&str>) -> bool {
    value.unwrap_or_default().is_empty()
}
