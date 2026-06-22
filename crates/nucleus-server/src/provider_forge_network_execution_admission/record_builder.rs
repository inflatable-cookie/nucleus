use crate::{
    ForgePullRequestRunnerRequestAdapterRecord, ForgePullRequestRunnerRequestAdapterStatus,
};

use super::types::{
    ForgeNetworkCredentialStatus, ForgeNetworkExecutionAdmissionBlocker,
    ForgeNetworkExecutionAdmissionInput, ForgeNetworkExecutionAdmissionRecord,
    ForgeNetworkExecutionAdmissionStatus,
};

pub(super) fn admission_record(
    input: &ForgeNetworkExecutionAdmissionInput,
    request: ForgePullRequestRunnerRequestAdapterRecord,
) -> ForgeNetworkExecutionAdmissionRecord {
    let blockers = blockers(input, &request);
    let status = status(&blockers);
    let stopped_preflight_permitted =
        status == ForgeNetworkExecutionAdmissionStatus::ReadyForStoppedPreflight;

    ForgeNetworkExecutionAdmissionRecord {
        admission_id: format!(
            "forge-network-execution-admission:{}",
            request.request_adapter_id
        ),
        request_adapter_id: request.request_adapter_id,
        upstream_admission_id: request.admission_id,
        request_id: request.request_id,
        task_id: request.task_id,
        repo_id: request.repo_id,
        operator_ref: request.operator_ref,
        operation_family: input.operation_family.clone(),
        credential_ref: input.credential_ref.clone(),
        network_authority_ref: input.network_authority_ref.clone(),
        operator_approval_ref: input.operator_approval_ref.clone(),
        idempotency_key: input.idempotency_key.clone(),
        retry_policy_ref: input.retry_policy_ref.clone(),
        recovery_policy_ref: input.recovery_policy_ref.clone(),
        sanitization_policy_ref: input.sanitization_policy_ref.clone(),
        forge_provider: request.forge_provider,
        remote_target: request.remote_target,
        base_branch: request.base_branch,
        head_branch: request.head_branch,
        title_source: request.title_source,
        body_source: request.body_source,
        status,
        blockers,
        stopped_preflight_permitted,
        credential_resolution_performed: false,
        provider_network_call_performed: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn blockers(
    input: &ForgeNetworkExecutionAdmissionInput,
    request: &ForgePullRequestRunnerRequestAdapterRecord,
) -> Vec<ForgeNetworkExecutionAdmissionBlocker> {
    let mut blockers = Vec::new();
    if request.status != ForgePullRequestRunnerRequestAdapterStatus::Ready
        || !request.provider_request_prepared
    {
        blockers.push(ForgeNetworkExecutionAdmissionBlocker::ProviderRequestNotPrepared);
    }
    if request.forge_provider.is_none() {
        blockers.push(ForgeNetworkExecutionAdmissionBlocker::MissingForgeProvider);
    }
    credential_blockers(input, &mut blockers);
    required_ref_blockers(input, &mut blockers);
    forbidden_blockers(input, &mut blockers);
    blockers
}

fn credential_blockers(
    input: &ForgeNetworkExecutionAdmissionInput,
    blockers: &mut Vec<ForgeNetworkExecutionAdmissionBlocker>,
) {
    let Some(credential_ref) = input.credential_ref.as_ref() else {
        blockers.push(ForgeNetworkExecutionAdmissionBlocker::MissingCredentialRef);
        return;
    };

    if credential_ref.status != ForgeNetworkCredentialStatus::Ready {
        blockers.push(ForgeNetworkExecutionAdmissionBlocker::CredentialNotReady);
    }
    if !credential_ref.allowed_operation_families.is_empty()
        && !credential_ref
            .allowed_operation_families
            .contains(&input.operation_family)
    {
        blockers.push(ForgeNetworkExecutionAdmissionBlocker::CredentialOperationNotAllowed);
    }
}

fn required_ref_blockers(
    input: &ForgeNetworkExecutionAdmissionInput,
    blockers: &mut Vec<ForgeNetworkExecutionAdmissionBlocker>,
) {
    if input
        .network_authority_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(ForgeNetworkExecutionAdmissionBlocker::MissingNetworkAuthorityRef);
    }
    if input.operation_family.is_mutating()
        && input
            .operator_approval_ref
            .as_deref()
            .unwrap_or_default()
            .is_empty()
    {
        blockers.push(ForgeNetworkExecutionAdmissionBlocker::MissingOperatorApprovalRef);
    }
    if input
        .idempotency_key
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(ForgeNetworkExecutionAdmissionBlocker::MissingIdempotencyKey);
    }
    if input
        .retry_policy_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(ForgeNetworkExecutionAdmissionBlocker::MissingRetryPolicyRef);
    }
    if input
        .recovery_policy_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(ForgeNetworkExecutionAdmissionBlocker::MissingRecoveryPolicyRef);
    }
    if input
        .sanitization_policy_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(ForgeNetworkExecutionAdmissionBlocker::MissingSanitizationPolicyRef);
    }
    if input.operation_family.is_deferred() {
        blockers.push(ForgeNetworkExecutionAdmissionBlocker::DeferredOperationFamily);
    }
}

fn forbidden_blockers(
    input: &ForgeNetworkExecutionAdmissionInput,
    blockers: &mut Vec<ForgeNetworkExecutionAdmissionBlocker>,
) {
    if input.raw_provider_payload_retention_requested {
        blockers.push(ForgeNetworkExecutionAdmissionBlocker::RawProviderPayloadRetentionRequested);
    }
    if input.real_credential_resolution_requested {
        blockers.push(ForgeNetworkExecutionAdmissionBlocker::RealCredentialResolutionRequested);
    }
    if input.provider_network_call_requested {
        blockers.push(ForgeNetworkExecutionAdmissionBlocker::ProviderNetworkCallRequested);
    }
    if input.callback_execution_requested {
        blockers.push(ForgeNetworkExecutionAdmissionBlocker::CallbackExecutionRequested);
    }
    if input.interruption_execution_requested {
        blockers.push(ForgeNetworkExecutionAdmissionBlocker::InterruptionExecutionRequested);
    }
    if input.recovery_execution_requested {
        blockers.push(ForgeNetworkExecutionAdmissionBlocker::RecoveryExecutionRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ForgeNetworkExecutionAdmissionBlocker::TaskMutationRequested);
    }
}

fn status(
    blockers: &[ForgeNetworkExecutionAdmissionBlocker],
) -> ForgeNetworkExecutionAdmissionStatus {
    if blockers.is_empty() {
        ForgeNetworkExecutionAdmissionStatus::ReadyForStoppedPreflight
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ForgeNetworkExecutionAdmissionBlocker::ProviderRequestNotPrepared
                | ForgeNetworkExecutionAdmissionBlocker::MissingForgeProvider
                | ForgeNetworkExecutionAdmissionBlocker::MissingCredentialRef
                | ForgeNetworkExecutionAdmissionBlocker::CredentialNotReady
                | ForgeNetworkExecutionAdmissionBlocker::CredentialOperationNotAllowed
                | ForgeNetworkExecutionAdmissionBlocker::MissingNetworkAuthorityRef
                | ForgeNetworkExecutionAdmissionBlocker::MissingOperatorApprovalRef
                | ForgeNetworkExecutionAdmissionBlocker::MissingIdempotencyKey
                | ForgeNetworkExecutionAdmissionBlocker::MissingRetryPolicyRef
                | ForgeNetworkExecutionAdmissionBlocker::MissingRecoveryPolicyRef
                | ForgeNetworkExecutionAdmissionBlocker::MissingSanitizationPolicyRef
        )
    }) {
        ForgeNetworkExecutionAdmissionStatus::RepairRequired
    } else {
        ForgeNetworkExecutionAdmissionStatus::Blocked
    }
}
