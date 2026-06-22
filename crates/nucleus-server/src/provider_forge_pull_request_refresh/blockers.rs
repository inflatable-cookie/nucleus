use super::types::{
    ForgePullRequestRefreshBlocker, ForgePullRequestRefreshInput, ForgePullRequestRefreshScope,
    ForgePullRequestRefreshStatus,
};

pub(super) fn blockers(
    input: &ForgePullRequestRefreshInput,
    provider_context_ref: &str,
) -> Vec<ForgePullRequestRefreshBlocker> {
    let mut blockers = Vec::new();
    if provider_context_ref.is_empty() {
        blockers.push(ForgePullRequestRefreshBlocker::EmptyProviderContextRef);
    }
    required_ref_blockers(input, &mut blockers);
    forbidden_blockers(input, &mut blockers);
    blockers
}

pub(super) fn status(blockers: &[ForgePullRequestRefreshBlocker]) -> ForgePullRequestRefreshStatus {
    if blockers.is_empty() {
        ForgePullRequestRefreshStatus::ReadyForStoppedRefresh
    } else if blockers.iter().any(repair_blocker) {
        ForgePullRequestRefreshStatus::RepairRequired
    } else {
        ForgePullRequestRefreshStatus::Blocked
    }
}

fn required_ref_blockers(
    input: &ForgePullRequestRefreshInput,
    blockers: &mut Vec<ForgePullRequestRefreshBlocker>,
) {
    if is_empty_ref(input.provider_instance_ref.as_deref()) {
        blockers.push(ForgePullRequestRefreshBlocker::MissingProviderInstanceRef);
    }
    if input.forge_provider.is_none() {
        blockers.push(ForgePullRequestRefreshBlocker::MissingForgeProvider);
    }
    if is_empty_ref(input.remote_repo_ref.as_deref()) {
        blockers.push(ForgePullRequestRefreshBlocker::MissingRemoteRepoRef);
    }
    refresh_scope_blockers(input, blockers);
    evidence_ref_blockers(input, blockers);
}

fn refresh_scope_blockers(
    input: &ForgePullRequestRefreshInput,
    blockers: &mut Vec<ForgePullRequestRefreshBlocker>,
) {
    match &input.refresh_scope {
        Some(ForgePullRequestRefreshScope::ChangeRequestRef(change_request_ref))
            if change_request_ref.is_empty() =>
        {
            blockers.push(ForgePullRequestRefreshBlocker::EmptyChangeRequestRef);
        }
        Some(_) => {}
        None => blockers.push(ForgePullRequestRefreshBlocker::MissingRefreshScope),
    }
}

fn evidence_ref_blockers(
    input: &ForgePullRequestRefreshInput,
    blockers: &mut Vec<ForgePullRequestRefreshBlocker>,
) {
    if is_empty_ref(input.credential_status_evidence_ref.as_deref()) {
        blockers.push(ForgePullRequestRefreshBlocker::MissingCredentialStatusEvidenceRef);
    }
    if is_empty_ref(input.repository_metadata_evidence_ref.as_deref()) {
        blockers.push(ForgePullRequestRefreshBlocker::MissingRepositoryMetadataEvidenceRef);
    }
    if is_empty_ref(input.pull_request_refresh_evidence_ref.as_deref()) {
        blockers.push(ForgePullRequestRefreshBlocker::MissingPullRequestRefreshEvidenceRef);
    }
    if is_empty_ref(input.sanitization_policy_ref.as_deref()) {
        blockers.push(ForgePullRequestRefreshBlocker::MissingSanitizationPolicyRef);
    }
}

fn forbidden_blockers(
    input: &ForgePullRequestRefreshInput,
    blockers: &mut Vec<ForgePullRequestRefreshBlocker>,
) {
    if input.credential_material_present {
        blockers.push(ForgePullRequestRefreshBlocker::CredentialMaterialPresent);
    }
    if input.provider_payload_present {
        blockers.push(ForgePullRequestRefreshBlocker::ProviderPayloadPresent);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(ForgePullRequestRefreshBlocker::RawProviderPayloadRetentionRequested);
    }
    if input.real_credential_resolution_requested {
        blockers.push(ForgePullRequestRefreshBlocker::RealCredentialResolutionRequested);
    }
    if input.provider_network_call_requested {
        blockers.push(ForgePullRequestRefreshBlocker::ProviderNetworkCallRequested);
    }
    if input.callback_execution_requested {
        blockers.push(ForgePullRequestRefreshBlocker::CallbackExecutionRequested);
    }
    if input.interruption_execution_requested {
        blockers.push(ForgePullRequestRefreshBlocker::InterruptionExecutionRequested);
    }
    if input.recovery_execution_requested {
        blockers.push(ForgePullRequestRefreshBlocker::RecoveryExecutionRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ForgePullRequestRefreshBlocker::TaskMutationRequested);
    }
}

fn repair_blocker(blocker: &ForgePullRequestRefreshBlocker) -> bool {
    matches!(
        blocker,
        ForgePullRequestRefreshBlocker::EmptyProviderContextRef
            | ForgePullRequestRefreshBlocker::MissingProviderInstanceRef
            | ForgePullRequestRefreshBlocker::MissingForgeProvider
            | ForgePullRequestRefreshBlocker::MissingRemoteRepoRef
            | ForgePullRequestRefreshBlocker::MissingRefreshScope
            | ForgePullRequestRefreshBlocker::EmptyChangeRequestRef
            | ForgePullRequestRefreshBlocker::MissingCredentialStatusEvidenceRef
            | ForgePullRequestRefreshBlocker::MissingRepositoryMetadataEvidenceRef
            | ForgePullRequestRefreshBlocker::MissingPullRequestRefreshEvidenceRef
            | ForgePullRequestRefreshBlocker::MissingSanitizationPolicyRef
    )
}

fn is_empty_ref(value: Option<&str>) -> bool {
    value.unwrap_or_default().is_empty()
}
