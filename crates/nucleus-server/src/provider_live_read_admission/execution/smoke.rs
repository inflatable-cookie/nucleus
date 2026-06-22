use crate::ForgeNetworkExecutionOperationFamily;

use super::smoke_types::{
    ProviderLiveReadSmokeAuthorityChecklistBlocker, ProviderLiveReadSmokeAuthorityChecklistInput,
    ProviderLiveReadSmokeAuthorityChecklistRecord, ProviderLiveReadSmokeAuthorityChecklistStatus,
    ProviderLiveReadSmokeRequestBlocker, ProviderLiveReadSmokeRequestInput,
    ProviderLiveReadSmokeRequestRecord, ProviderLiveReadSmokeRequestStatus,
    ProviderLiveReadSmokeTargetBlocker, ProviderLiveReadSmokeTargetInput,
    ProviderLiveReadSmokeTargetRecord, ProviderLiveReadSmokeTargetStatus,
};

pub fn provider_live_read_smoke_target(
    input: ProviderLiveReadSmokeTargetInput,
) -> ProviderLiveReadSmokeTargetRecord {
    let blockers = target_blockers(&input);
    let status = target_status(&blockers);
    let mut evidence_refs = input.local_evidence_refs.clone();
    if let Some(ref evidence_ref) = input.smoke_target_evidence_ref {
        evidence_refs.push(evidence_ref.clone());
    }
    evidence_refs.sort();
    evidence_refs.dedup();

    ProviderLiveReadSmokeTargetRecord {
        smoke_target_id: format!("provider-live-read-smoke-target:{}", input.smoke_target_ref),
        smoke_target_ref: input.smoke_target_ref,
        provider_family_ref: input.provider_family_ref,
        provider_instance_ref: input.provider_instance_ref,
        forge_provider: input.forge_provider,
        remote_repo_ref: input.remote_repo_ref,
        operation_family: input.operation_family,
        target_refs: input.target_refs,
        local_evidence_refs: input.local_evidence_refs,
        smoke_target_evidence_ref: input.smoke_target_evidence_ref,
        evidence_refs,
        status,
        blockers,
        provider_network_call_performed: false,
        credential_resolution_performed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

pub fn provider_live_read_smoke_authority_checklist(
    input: ProviderLiveReadSmokeAuthorityChecklistInput,
) -> ProviderLiveReadSmokeAuthorityChecklistRecord {
    let blockers = checklist_blockers(&input);
    let status = checklist_status(&blockers);
    let mut evidence_refs = input.target.evidence_refs.clone();
    optional_push(&mut evidence_refs, &input.checklist_evidence_ref);
    evidence_refs.sort();
    evidence_refs.dedup();

    ProviderLiveReadSmokeAuthorityChecklistRecord {
        checklist_id: format!(
            "provider-live-read-smoke-checklist:{}",
            input.target.smoke_target_id
        ),
        smoke_target_id: input.target.smoke_target_id,
        credential_lease_ref: input.credential_lease_ref,
        network_read_authority_ref: input.network_read_authority_ref,
        payload_policy_ref: input.payload_policy_ref,
        sanitization_policy_ref: input.sanitization_policy_ref,
        retention_policy_ref: input.retention_policy_ref,
        operator_approval_ref: input.operator_approval_ref,
        checklist_evidence_ref: input.checklist_evidence_ref,
        evidence_refs,
        status,
        blockers,
        provider_network_call_performed: false,
        credential_resolution_performed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

pub fn provider_live_read_smoke_request(
    input: ProviderLiveReadSmokeRequestInput,
) -> ProviderLiveReadSmokeRequestRecord {
    let smoke_request_id = format!(
        "provider-live-read-smoke-request:{}",
        input.checklist.checklist_id
    );
    let duplicate = input.existing_smoke_request_ids.contains(&smoke_request_id);
    let blockers = request_blockers(&input, duplicate);
    let status = request_status(&input, &blockers, duplicate);
    let mut evidence_refs = input.checklist.evidence_refs.clone();
    optional_push(&mut evidence_refs, &input.smoke_request_evidence_ref);
    evidence_refs.sort();
    evidence_refs.dedup();

    ProviderLiveReadSmokeRequestRecord {
        smoke_request_id,
        checklist_id: input.checklist.checklist_id,
        smoke_target_id: input.checklist.smoke_target_id,
        stopped_handoff_ref: input.stopped_handoff_ref,
        fixture_response_ref: input.fixture_response_ref,
        smoke_request_evidence_ref: input.smoke_request_evidence_ref,
        evidence_refs,
        status,
        blockers,
        duplicate_smoke_request_detected: duplicate,
        provider_network_call_performed: false,
        credential_resolution_performed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn target_blockers(
    input: &ProviderLiveReadSmokeTargetInput,
) -> Vec<ProviderLiveReadSmokeTargetBlocker> {
    let mut blockers = Vec::new();
    if input.smoke_target_ref.is_empty() {
        blockers.push(ProviderLiveReadSmokeTargetBlocker::MissingSmokeTargetRef);
    }
    if input.provider_family_ref.is_none() {
        blockers.push(ProviderLiveReadSmokeTargetBlocker::MissingProviderFamilyRef);
    }
    if input.provider_instance_ref.is_none() {
        blockers.push(ProviderLiveReadSmokeTargetBlocker::MissingProviderInstanceRef);
    }
    if input.forge_provider.is_none() {
        blockers.push(ProviderLiveReadSmokeTargetBlocker::MissingForgeProvider);
    }
    if input.remote_repo_ref.is_none() {
        blockers.push(ProviderLiveReadSmokeTargetBlocker::MissingRemoteRepoRef);
    }
    if input.target_refs.is_empty() {
        blockers.push(ProviderLiveReadSmokeTargetBlocker::MissingTargetRef);
    }
    if input.local_evidence_refs.is_empty() {
        blockers.push(ProviderLiveReadSmokeTargetBlocker::MissingLocalEvidenceRef);
    }
    if input.smoke_target_evidence_ref.is_none() {
        blockers.push(ProviderLiveReadSmokeTargetBlocker::MissingSmokeTargetEvidenceRef);
    }
    if !is_supported_read_family(&input.operation_family) {
        blockers.push(ProviderLiveReadSmokeTargetBlocker::UnsupportedOperationFamily);
    }
    if is_mutating_family(&input.operation_family) {
        blockers.push(ProviderLiveReadSmokeTargetBlocker::MutatingOperationFamily);
    }
    if input.provider_network_call_requested {
        blockers.push(ProviderLiveReadSmokeTargetBlocker::ProviderNetworkCallRequested);
    }
    if input.provider_write_requested {
        blockers.push(ProviderLiveReadSmokeTargetBlocker::ProviderWriteRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ProviderLiveReadSmokeTargetBlocker::TaskMutationRequested);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(ProviderLiveReadSmokeTargetBlocker::RawProviderPayloadRetentionRequested);
    }
    blockers
}

fn checklist_blockers(
    input: &ProviderLiveReadSmokeAuthorityChecklistInput,
) -> Vec<ProviderLiveReadSmokeAuthorityChecklistBlocker> {
    let mut blockers = Vec::new();
    if input.target.status != ProviderLiveReadSmokeTargetStatus::Selected {
        blockers.push(ProviderLiveReadSmokeAuthorityChecklistBlocker::TargetNotSelected);
    }
    if input.credential_lease_ref.is_none() {
        blockers.push(ProviderLiveReadSmokeAuthorityChecklistBlocker::MissingCredentialLeaseRef);
    }
    if input.network_read_authority_ref.is_none() {
        blockers
            .push(ProviderLiveReadSmokeAuthorityChecklistBlocker::MissingNetworkReadAuthorityRef);
    }
    if input.payload_policy_ref.is_none() {
        blockers.push(ProviderLiveReadSmokeAuthorityChecklistBlocker::MissingPayloadPolicyRef);
    }
    if input.sanitization_policy_ref.is_none() {
        blockers.push(ProviderLiveReadSmokeAuthorityChecklistBlocker::MissingSanitizationPolicyRef);
    }
    if input.retention_policy_ref.is_none() {
        blockers.push(ProviderLiveReadSmokeAuthorityChecklistBlocker::MissingRetentionPolicyRef);
    }
    if input.operator_approval_ref.is_none() {
        blockers.push(ProviderLiveReadSmokeAuthorityChecklistBlocker::MissingOperatorApprovalRef);
    }
    if input.checklist_evidence_ref.is_none() {
        blockers.push(ProviderLiveReadSmokeAuthorityChecklistBlocker::MissingChecklistEvidenceRef);
    }
    if input.credential_material_present {
        blockers.push(ProviderLiveReadSmokeAuthorityChecklistBlocker::CredentialMaterialPresent);
    }
    if input.provider_network_call_requested {
        blockers.push(ProviderLiveReadSmokeAuthorityChecklistBlocker::ProviderNetworkCallRequested);
    }
    if input.provider_write_requested {
        blockers.push(ProviderLiveReadSmokeAuthorityChecklistBlocker::ProviderWriteRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ProviderLiveReadSmokeAuthorityChecklistBlocker::TaskMutationRequested);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(
            ProviderLiveReadSmokeAuthorityChecklistBlocker::RawProviderPayloadRetentionRequested,
        );
    }
    blockers
}

fn request_blockers(
    input: &ProviderLiveReadSmokeRequestInput,
    duplicate: bool,
) -> Vec<ProviderLiveReadSmokeRequestBlocker> {
    let mut blockers = Vec::new();
    if duplicate {
        blockers.push(ProviderLiveReadSmokeRequestBlocker::DuplicateSmokeRequest);
    }
    if input.checklist.status
        != ProviderLiveReadSmokeAuthorityChecklistStatus::ReadyForStoppedSmokeRequest
    {
        blockers.push(ProviderLiveReadSmokeRequestBlocker::ChecklistNotReady);
    }
    if input.checklist.operator_approval_ref.is_none() {
        blockers.push(ProviderLiveReadSmokeRequestBlocker::MissingOperatorApprovalRef);
    }
    if input.stopped_handoff_ref.is_none() {
        blockers.push(ProviderLiveReadSmokeRequestBlocker::MissingStoppedHandoffRef);
    }
    if input.fixture_response_ref.is_none() {
        blockers.push(ProviderLiveReadSmokeRequestBlocker::MissingFixtureResponseRef);
    }
    if input.smoke_request_evidence_ref.is_none() {
        blockers.push(ProviderLiveReadSmokeRequestBlocker::MissingSmokeRequestEvidenceRef);
    }
    if input.provider_network_call_requested {
        blockers.push(ProviderLiveReadSmokeRequestBlocker::ProviderNetworkCallRequested);
    }
    if input.credential_material_present {
        blockers.push(ProviderLiveReadSmokeRequestBlocker::CredentialMaterialPresent);
    }
    if input.provider_write_requested {
        blockers.push(ProviderLiveReadSmokeRequestBlocker::ProviderWriteRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ProviderLiveReadSmokeRequestBlocker::TaskMutationRequested);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(ProviderLiveReadSmokeRequestBlocker::RawProviderPayloadRetentionRequested);
    }
    blockers
}

fn target_status(
    blockers: &[ProviderLiveReadSmokeTargetBlocker],
) -> ProviderLiveReadSmokeTargetStatus {
    if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ProviderLiveReadSmokeTargetBlocker::ProviderNetworkCallRequested
                | ProviderLiveReadSmokeTargetBlocker::ProviderWriteRequested
                | ProviderLiveReadSmokeTargetBlocker::TaskMutationRequested
                | ProviderLiveReadSmokeTargetBlocker::RawProviderPayloadRetentionRequested
                | ProviderLiveReadSmokeTargetBlocker::UnsupportedOperationFamily
                | ProviderLiveReadSmokeTargetBlocker::MutatingOperationFamily
        )
    }) {
        ProviderLiveReadSmokeTargetStatus::Blocked
    } else if blockers.is_empty() {
        ProviderLiveReadSmokeTargetStatus::Selected
    } else {
        ProviderLiveReadSmokeTargetStatus::RepairRequired
    }
}

fn checklist_status(
    blockers: &[ProviderLiveReadSmokeAuthorityChecklistBlocker],
) -> ProviderLiveReadSmokeAuthorityChecklistStatus {
    if blockers
        .iter()
        .any(|blocker| matches!(blocker, ProviderLiveReadSmokeAuthorityChecklistBlocker::MissingOperatorApprovalRef))
    {
        ProviderLiveReadSmokeAuthorityChecklistStatus::ApprovalRequired
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ProviderLiveReadSmokeAuthorityChecklistBlocker::CredentialMaterialPresent
                | ProviderLiveReadSmokeAuthorityChecklistBlocker::ProviderNetworkCallRequested
                | ProviderLiveReadSmokeAuthorityChecklistBlocker::ProviderWriteRequested
                | ProviderLiveReadSmokeAuthorityChecklistBlocker::TaskMutationRequested
                | ProviderLiveReadSmokeAuthorityChecklistBlocker::RawProviderPayloadRetentionRequested
                | ProviderLiveReadSmokeAuthorityChecklistBlocker::TargetNotSelected
        )
    }) {
        ProviderLiveReadSmokeAuthorityChecklistStatus::Blocked
    } else if blockers.is_empty() {
        ProviderLiveReadSmokeAuthorityChecklistStatus::ReadyForStoppedSmokeRequest
    } else {
        ProviderLiveReadSmokeAuthorityChecklistStatus::RepairRequired
    }
}

fn request_status(
    input: &ProviderLiveReadSmokeRequestInput,
    blockers: &[ProviderLiveReadSmokeRequestBlocker],
    duplicate: bool,
) -> ProviderLiveReadSmokeRequestStatus {
    if duplicate {
        ProviderLiveReadSmokeRequestStatus::DuplicateNoop
    } else if input.checklist.operator_approval_ref.is_none() {
        ProviderLiveReadSmokeRequestStatus::ApprovalRequired
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ProviderLiveReadSmokeRequestBlocker::ProviderNetworkCallRequested
                | ProviderLiveReadSmokeRequestBlocker::CredentialMaterialPresent
                | ProviderLiveReadSmokeRequestBlocker::ProviderWriteRequested
                | ProviderLiveReadSmokeRequestBlocker::TaskMutationRequested
                | ProviderLiveReadSmokeRequestBlocker::RawProviderPayloadRetentionRequested
                | ProviderLiveReadSmokeRequestBlocker::ChecklistNotReady
        )
    }) {
        ProviderLiveReadSmokeRequestStatus::Blocked
    } else if blockers.is_empty() {
        ProviderLiveReadSmokeRequestStatus::StoppedPendingExplicitExecution
    } else {
        ProviderLiveReadSmokeRequestStatus::RepairRequired
    }
}

fn is_supported_read_family(operation_family: &ForgeNetworkExecutionOperationFamily) -> bool {
    matches!(
        operation_family,
        ForgeNetworkExecutionOperationFamily::ProviderAuthStatusRefresh
            | ForgeNetworkExecutionOperationFamily::RepositoryMetadataRefresh
            | ForgeNetworkExecutionOperationFamily::PullRequestRefresh
            | ForgeNetworkExecutionOperationFamily::IssueRefresh
            | ForgeNetworkExecutionOperationFamily::CommentRefresh
            | ForgeNetworkExecutionOperationFamily::ReviewWorkflowRefresh
            | ForgeNetworkExecutionOperationFamily::StatusCheckRefresh
    )
}

fn is_mutating_family(operation_family: &ForgeNetworkExecutionOperationFamily) -> bool {
    matches!(
        operation_family,
        ForgeNetworkExecutionOperationFamily::PullRequestCreate
            | ForgeNetworkExecutionOperationFamily::PullRequestUpdate
            | ForgeNetworkExecutionOperationFamily::CommentCreate
            | ForgeNetworkExecutionOperationFamily::ReviewRequestUpdate
            | ForgeNetworkExecutionOperationFamily::LabelOrMetadataUpdate
            | ForgeNetworkExecutionOperationFamily::StatusCheckUpdate
    )
}

fn optional_push(values: &mut Vec<String>, value: &Option<String>) {
    if let Some(value) = value {
        values.push(value.clone());
    }
}
