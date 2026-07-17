use crate::provider_no_effects::{ProviderNoEffects, ProviderRuntimeNoEffects};
use crate::{ForgeNetworkCredentialStatus, ForgeNetworkExecutionCredentialRef};

use super::types::{
    ForgeCredentialStatusClass, ForgeCredentialStatusRefreshBlocker,
    ForgeCredentialStatusRefreshInput, ForgeCredentialStatusRefreshRecord,
    ForgeCredentialStatusRefreshStatus,
};

pub(super) fn refresh_record(
    input: &ForgeCredentialStatusRefreshInput,
    credential_ref: ForgeNetworkExecutionCredentialRef,
) -> ForgeCredentialStatusRefreshRecord {
    let blockers = blockers(input);
    let status = status(&blockers);

    ForgeCredentialStatusRefreshRecord {
        refresh_id: format!(
            "forge-credential-status-refresh:{}",
            credential_ref.credential_ref_id
        ),
        credential_ref_id: credential_ref.credential_ref_id,
        credential_kind: credential_ref.credential_kind,
        resolution_boundary: credential_ref.resolution_boundary,
        status_class: status_class(&credential_ref.status),
        current_status: credential_ref.status,
        allowed_operation_families: credential_ref.allowed_operation_families,
        provider_context_ref: input.provider_context_ref.clone(),
        status_refresh_evidence_ref: input.status_refresh_evidence_ref.clone(),
        sanitization_policy_ref: input.sanitization_policy_ref.clone(),
        stopped_refresh_recorded: status
            == ForgeCredentialStatusRefreshStatus::ReadyForStoppedRefresh,
        status,
        blockers,
        no_effects: ProviderRuntimeNoEffects::none(),
    }
}

fn blockers(input: &ForgeCredentialStatusRefreshInput) -> Vec<ForgeCredentialStatusRefreshBlocker> {
    let mut blockers = Vec::new();
    if input
        .provider_context_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(ForgeCredentialStatusRefreshBlocker::MissingProviderContextRef);
    }
    if input
        .status_refresh_evidence_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(ForgeCredentialStatusRefreshBlocker::MissingStatusRefreshEvidenceRef);
    }
    if input
        .sanitization_policy_ref
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push(ForgeCredentialStatusRefreshBlocker::MissingSanitizationPolicyRef);
    }
    forbidden_blockers(input, &mut blockers);
    blockers
}

fn forbidden_blockers(
    input: &ForgeCredentialStatusRefreshInput,
    blockers: &mut Vec<ForgeCredentialStatusRefreshBlocker>,
) {
    if input.credential_material_present {
        blockers.push(ForgeCredentialStatusRefreshBlocker::CredentialMaterialPresent);
    }
    if input.provider_payload_present {
        blockers.push(ForgeCredentialStatusRefreshBlocker::ProviderPayloadPresent);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(ForgeCredentialStatusRefreshBlocker::RawProviderPayloadRetentionRequested);
    }
    if input.real_credential_resolution_requested {
        blockers.push(ForgeCredentialStatusRefreshBlocker::RealCredentialResolutionRequested);
    }
    if input.provider_network_call_requested {
        blockers.push(ForgeCredentialStatusRefreshBlocker::ProviderNetworkCallRequested);
    }
    if input.callback_execution_requested {
        blockers.push(ForgeCredentialStatusRefreshBlocker::CallbackExecutionRequested);
    }
    if input.interruption_execution_requested {
        blockers.push(ForgeCredentialStatusRefreshBlocker::InterruptionExecutionRequested);
    }
    if input.recovery_execution_requested {
        blockers.push(ForgeCredentialStatusRefreshBlocker::RecoveryExecutionRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ForgeCredentialStatusRefreshBlocker::TaskMutationRequested);
    }
}

fn status(blockers: &[ForgeCredentialStatusRefreshBlocker]) -> ForgeCredentialStatusRefreshStatus {
    if blockers.is_empty() {
        ForgeCredentialStatusRefreshStatus::ReadyForStoppedRefresh
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ForgeCredentialStatusRefreshBlocker::MissingProviderContextRef
                | ForgeCredentialStatusRefreshBlocker::MissingStatusRefreshEvidenceRef
                | ForgeCredentialStatusRefreshBlocker::MissingSanitizationPolicyRef
        )
    }) {
        ForgeCredentialStatusRefreshStatus::RepairRequired
    } else {
        ForgeCredentialStatusRefreshStatus::Blocked
    }
}

fn status_class(status: &ForgeNetworkCredentialStatus) -> ForgeCredentialStatusClass {
    match status {
        ForgeNetworkCredentialStatus::Ready => ForgeCredentialStatusClass::Ready,
        ForgeNetworkCredentialStatus::Expired
        | ForgeNetworkCredentialStatus::Revoked
        | ForgeNetworkCredentialStatus::PermissionDenied
        | ForgeNetworkCredentialStatus::RequiresUserAction
        | ForgeNetworkCredentialStatus::MissingScope
        | ForgeNetworkCredentialStatus::RepairRequired => {
            ForgeCredentialStatusClass::RequiresRepair
        }
        ForgeNetworkCredentialStatus::Unsupported => ForgeCredentialStatusClass::Unsupported,
        ForgeNetworkCredentialStatus::Unresolved
        | ForgeNetworkCredentialStatus::ProviderUnavailable
        | ForgeNetworkCredentialStatus::Unknown => ForgeCredentialStatusClass::Unknown,
    }
}
