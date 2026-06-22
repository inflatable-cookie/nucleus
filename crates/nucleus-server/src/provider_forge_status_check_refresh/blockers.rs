use super::types::{
    ForgeStatusCheckRefreshBlocker, ForgeStatusCheckRefreshInput, ForgeStatusCheckRefreshScope,
    ForgeStatusCheckRefreshStatus,
};

pub(super) fn blockers(
    input: &ForgeStatusCheckRefreshInput,
    provider_context_ref: &str,
) -> Vec<ForgeStatusCheckRefreshBlocker> {
    let mut blockers = Vec::new();
    if provider_context_ref.is_empty() {
        blockers.push(ForgeStatusCheckRefreshBlocker::EmptyProviderContextRef);
    }
    required_ref_blockers(input, &mut blockers);
    forbidden_blockers(input, &mut blockers);
    blockers
}

pub(super) fn status(blockers: &[ForgeStatusCheckRefreshBlocker]) -> ForgeStatusCheckRefreshStatus {
    if blockers.is_empty() {
        ForgeStatusCheckRefreshStatus::ReadyForStoppedRefresh
    } else if blockers.iter().any(repair_blocker) {
        ForgeStatusCheckRefreshStatus::RepairRequired
    } else {
        ForgeStatusCheckRefreshStatus::Blocked
    }
}

fn required_ref_blockers(
    input: &ForgeStatusCheckRefreshInput,
    blockers: &mut Vec<ForgeStatusCheckRefreshBlocker>,
) {
    if is_empty_ref(input.provider_instance_ref.as_deref()) {
        blockers.push(ForgeStatusCheckRefreshBlocker::MissingProviderInstanceRef);
    }
    if input.forge_provider.is_none() {
        blockers.push(ForgeStatusCheckRefreshBlocker::MissingForgeProvider);
    }
    if is_empty_ref(input.remote_repo_ref.as_deref()) {
        blockers.push(ForgeStatusCheckRefreshBlocker::MissingRemoteRepoRef);
    }
    refresh_scope_blockers(input, blockers);
    evidence_ref_blockers(input, blockers);
}

fn refresh_scope_blockers(
    input: &ForgeStatusCheckRefreshInput,
    blockers: &mut Vec<ForgeStatusCheckRefreshBlocker>,
) {
    match &input.refresh_scope {
        Some(ForgeStatusCheckRefreshScope::ChangeRequestRef(change_request_ref))
            if change_request_ref.is_empty() =>
        {
            blockers.push(ForgeStatusCheckRefreshBlocker::EmptyChangeRequestRef);
        }
        Some(ForgeStatusCheckRefreshScope::CommitRef(commit_ref)) if commit_ref.is_empty() => {
            blockers.push(ForgeStatusCheckRefreshBlocker::EmptyCommitRef);
        }
        Some(ForgeStatusCheckRefreshScope::BranchRef(branch_ref)) if branch_ref.is_empty() => {
            blockers.push(ForgeStatusCheckRefreshBlocker::EmptyBranchRef);
        }
        Some(_) => {}
        None => blockers.push(ForgeStatusCheckRefreshBlocker::MissingRefreshScope),
    }
}

fn evidence_ref_blockers(
    input: &ForgeStatusCheckRefreshInput,
    blockers: &mut Vec<ForgeStatusCheckRefreshBlocker>,
) {
    if is_empty_ref(input.credential_status_evidence_ref.as_deref()) {
        blockers.push(ForgeStatusCheckRefreshBlocker::MissingCredentialStatusEvidenceRef);
    }
    if is_empty_ref(input.repository_metadata_evidence_ref.as_deref()) {
        blockers.push(ForgeStatusCheckRefreshBlocker::MissingRepositoryMetadataEvidenceRef);
    }
    if is_empty_ref(input.status_check_refresh_evidence_ref.as_deref()) {
        blockers.push(ForgeStatusCheckRefreshBlocker::MissingStatusCheckRefreshEvidenceRef);
    }
    if is_empty_ref(input.sanitization_policy_ref.as_deref()) {
        blockers.push(ForgeStatusCheckRefreshBlocker::MissingSanitizationPolicyRef);
    }
}

fn forbidden_blockers(
    input: &ForgeStatusCheckRefreshInput,
    blockers: &mut Vec<ForgeStatusCheckRefreshBlocker>,
) {
    if input.credential_material_present {
        blockers.push(ForgeStatusCheckRefreshBlocker::CredentialMaterialPresent);
    }
    if input.provider_payload_present {
        blockers.push(ForgeStatusCheckRefreshBlocker::ProviderPayloadPresent);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(ForgeStatusCheckRefreshBlocker::RawProviderPayloadRetentionRequested);
    }
    if input.real_credential_resolution_requested {
        blockers.push(ForgeStatusCheckRefreshBlocker::RealCredentialResolutionRequested);
    }
    if input.provider_network_call_requested {
        blockers.push(ForgeStatusCheckRefreshBlocker::ProviderNetworkCallRequested);
    }
    if input.callback_execution_requested {
        blockers.push(ForgeStatusCheckRefreshBlocker::CallbackExecutionRequested);
    }
    if input.interruption_execution_requested {
        blockers.push(ForgeStatusCheckRefreshBlocker::InterruptionExecutionRequested);
    }
    if input.recovery_execution_requested {
        blockers.push(ForgeStatusCheckRefreshBlocker::RecoveryExecutionRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ForgeStatusCheckRefreshBlocker::TaskMutationRequested);
    }
}

fn repair_blocker(blocker: &ForgeStatusCheckRefreshBlocker) -> bool {
    matches!(
        blocker,
        ForgeStatusCheckRefreshBlocker::EmptyProviderContextRef
            | ForgeStatusCheckRefreshBlocker::MissingProviderInstanceRef
            | ForgeStatusCheckRefreshBlocker::MissingForgeProvider
            | ForgeStatusCheckRefreshBlocker::MissingRemoteRepoRef
            | ForgeStatusCheckRefreshBlocker::MissingRefreshScope
            | ForgeStatusCheckRefreshBlocker::EmptyChangeRequestRef
            | ForgeStatusCheckRefreshBlocker::EmptyCommitRef
            | ForgeStatusCheckRefreshBlocker::EmptyBranchRef
            | ForgeStatusCheckRefreshBlocker::MissingCredentialStatusEvidenceRef
            | ForgeStatusCheckRefreshBlocker::MissingRepositoryMetadataEvidenceRef
            | ForgeStatusCheckRefreshBlocker::MissingStatusCheckRefreshEvidenceRef
            | ForgeStatusCheckRefreshBlocker::MissingSanitizationPolicyRef
    )
}

fn is_empty_ref(value: Option<&str>) -> bool {
    value.unwrap_or_default().is_empty()
}
