use crate::ForgeNetworkExecutionOperationFamily;

use super::types::{
    ProviderLiveReadAdmissionBlocker, ProviderLiveReadAdmissionInput,
    ProviderLiveReadAdmissionStatus,
};

pub(super) fn blockers(
    input: &ProviderLiveReadAdmissionInput,
    provider_context_ref: &str,
) -> Vec<ProviderLiveReadAdmissionBlocker> {
    let mut blockers = Vec::new();
    if provider_context_ref.is_empty() {
        blockers.push(ProviderLiveReadAdmissionBlocker::EmptyProviderContextRef);
    }
    required_ref_blockers(input, &mut blockers);
    operation_family_blockers(input, &mut blockers);
    forbidden_blockers(input, &mut blockers);
    blockers
}

pub(super) fn status(
    blockers: &[ProviderLiveReadAdmissionBlocker],
) -> ProviderLiveReadAdmissionStatus {
    if blockers.is_empty() {
        ProviderLiveReadAdmissionStatus::ReadyForFixturePreflight
    } else if blockers.iter().any(blocking_blocker) {
        ProviderLiveReadAdmissionStatus::Blocked
    } else if blockers.iter().any(unsupported_blocker) {
        ProviderLiveReadAdmissionStatus::Unsupported
    } else {
        ProviderLiveReadAdmissionStatus::RepairRequired
    }
}

fn required_ref_blockers(
    input: &ProviderLiveReadAdmissionInput,
    blockers: &mut Vec<ProviderLiveReadAdmissionBlocker>,
) {
    if is_empty_ref(input.provider_instance_ref.as_deref()) {
        blockers.push(ProviderLiveReadAdmissionBlocker::MissingProviderInstanceRef);
    }
    if input.forge_provider.is_none() {
        blockers.push(ProviderLiveReadAdmissionBlocker::MissingForgeProvider);
    }
    if is_empty_ref(input.remote_repo_ref.as_deref()) {
        blockers.push(ProviderLiveReadAdmissionBlocker::MissingRemoteRepoRef);
    }
    if input
        .target_refs
        .iter()
        .all(|target_ref| target_ref.is_empty())
    {
        blockers.push(ProviderLiveReadAdmissionBlocker::MissingTargetRef);
    }
    if input
        .credential_status_evidence_refs
        .iter()
        .all(|evidence_ref| evidence_ref.is_empty())
    {
        blockers.push(ProviderLiveReadAdmissionBlocker::MissingCredentialStatusEvidenceRef);
    }
    if is_empty_ref(input.network_authority_ref.as_deref()) {
        blockers.push(ProviderLiveReadAdmissionBlocker::MissingNetworkAuthorityRef);
    }
    if is_empty_ref(input.payload_policy_ref.as_deref()) {
        blockers.push(ProviderLiveReadAdmissionBlocker::MissingPayloadPolicyRef);
    }
    if is_empty_ref(input.sanitization_policy_ref.as_deref()) {
        blockers.push(ProviderLiveReadAdmissionBlocker::MissingSanitizationPolicyRef);
    }
    if is_empty_ref(input.admission_evidence_ref.as_deref()) {
        blockers.push(ProviderLiveReadAdmissionBlocker::MissingAdmissionEvidenceRef);
    }
}

fn operation_family_blockers(
    input: &ProviderLiveReadAdmissionInput,
    blockers: &mut Vec<ProviderLiveReadAdmissionBlocker>,
) {
    if input.operation_family.is_mutating() {
        blockers.push(ProviderLiveReadAdmissionBlocker::MutatingOperationFamily);
        return;
    }
    if !supported_read_family(&input.operation_family) {
        blockers.push(ProviderLiveReadAdmissionBlocker::UnsupportedOperationFamily);
    }
}

fn forbidden_blockers(
    input: &ProviderLiveReadAdmissionInput,
    blockers: &mut Vec<ProviderLiveReadAdmissionBlocker>,
) {
    if input.credential_material_present {
        blockers.push(ProviderLiveReadAdmissionBlocker::CredentialMaterialPresent);
    }
    if input.provider_payload_present {
        blockers.push(ProviderLiveReadAdmissionBlocker::ProviderPayloadPresent);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(ProviderLiveReadAdmissionBlocker::RawProviderPayloadRetentionRequested);
    }
    if input.real_credential_resolution_requested {
        blockers.push(ProviderLiveReadAdmissionBlocker::RealCredentialResolutionRequested);
    }
    if input.provider_network_call_requested {
        blockers.push(ProviderLiveReadAdmissionBlocker::ProviderNetworkCallRequested);
    }
    if input.provider_write_requested {
        blockers.push(ProviderLiveReadAdmissionBlocker::ProviderWriteRequested);
    }
    if input.callback_execution_requested {
        blockers.push(ProviderLiveReadAdmissionBlocker::CallbackExecutionRequested);
    }
    if input.interruption_execution_requested {
        blockers.push(ProviderLiveReadAdmissionBlocker::InterruptionExecutionRequested);
    }
    if input.recovery_execution_requested {
        blockers.push(ProviderLiveReadAdmissionBlocker::RecoveryExecutionRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ProviderLiveReadAdmissionBlocker::TaskMutationRequested);
    }
}

fn supported_read_family(family: &ForgeNetworkExecutionOperationFamily) -> bool {
    matches!(
        family,
        ForgeNetworkExecutionOperationFamily::ProviderAuthStatusRefresh
            | ForgeNetworkExecutionOperationFamily::RepositoryMetadataRefresh
            | ForgeNetworkExecutionOperationFamily::PullRequestRefresh
            | ForgeNetworkExecutionOperationFamily::IssueRefresh
            | ForgeNetworkExecutionOperationFamily::CommentRefresh
            | ForgeNetworkExecutionOperationFamily::ReviewWorkflowRefresh
            | ForgeNetworkExecutionOperationFamily::StatusCheckRefresh
    )
}

fn blocking_blocker(blocker: &ProviderLiveReadAdmissionBlocker) -> bool {
    matches!(
        blocker,
        ProviderLiveReadAdmissionBlocker::CredentialMaterialPresent
            | ProviderLiveReadAdmissionBlocker::ProviderPayloadPresent
            | ProviderLiveReadAdmissionBlocker::RawProviderPayloadRetentionRequested
            | ProviderLiveReadAdmissionBlocker::RealCredentialResolutionRequested
            | ProviderLiveReadAdmissionBlocker::ProviderNetworkCallRequested
            | ProviderLiveReadAdmissionBlocker::ProviderWriteRequested
            | ProviderLiveReadAdmissionBlocker::CallbackExecutionRequested
            | ProviderLiveReadAdmissionBlocker::InterruptionExecutionRequested
            | ProviderLiveReadAdmissionBlocker::RecoveryExecutionRequested
            | ProviderLiveReadAdmissionBlocker::TaskMutationRequested
    )
}

fn unsupported_blocker(blocker: &ProviderLiveReadAdmissionBlocker) -> bool {
    matches!(
        blocker,
        ProviderLiveReadAdmissionBlocker::UnsupportedOperationFamily
            | ProviderLiveReadAdmissionBlocker::MutatingOperationFamily
    )
}

fn is_empty_ref(value: Option<&str>) -> bool {
    value.unwrap_or_default().is_empty()
}
