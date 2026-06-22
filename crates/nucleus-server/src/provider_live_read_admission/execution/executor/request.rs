use crate::ForgeNetworkExecutionOperationFamily;

use super::super::executor_types::{
    ProviderLiveReadServerRequestBlocker, ProviderLiveReadServerRequestInput,
    ProviderLiveReadServerRequestRecord, ProviderLiveReadServerRequestStatus,
};
use super::super::smoke_types::{
    ProviderLiveReadSmokeAuthorityChecklistStatus, ProviderLiveReadSmokeRequestStatus,
    ProviderLiveReadSmokeTargetStatus,
};

pub fn provider_live_read_executor_request(
    input: ProviderLiveReadServerRequestInput,
) -> ProviderLiveReadServerRequestRecord {
    let executor_request_id = format!(
        "provider-live-read-server-request:{}",
        input.smoke_request.smoke_request_id
    );
    let duplicate = input
        .existing_executor_request_ids
        .contains(&executor_request_id);
    let blockers = request_blockers(&input, duplicate);
    let status = request_status(&blockers, duplicate);
    let mut evidence_refs = input.smoke_request.evidence_refs.clone();
    optional_push(&mut evidence_refs, &input.output_evidence_ref);
    optional_push(&mut evidence_refs, &input.receipt_evidence_ref);
    evidence_refs.sort();
    evidence_refs.dedup();

    ProviderLiveReadServerRequestRecord {
        executor_request_id,
        smoke_target_id: input.smoke_target.smoke_target_id,
        checklist_id: input.checklist.checklist_id,
        smoke_request_id: input.smoke_request.smoke_request_id,
        operator_approval_ref: input.checklist.operator_approval_ref,
        network_read_authority_ref: input.checklist.network_read_authority_ref,
        credential_lease_ref: input.checklist.credential_lease_ref,
        executor_authority_ref: input.executor_authority_ref,
        command_descriptor_ref: input.command_descriptor_ref,
        output_evidence_ref: input.output_evidence_ref,
        receipt_evidence_ref: input.receipt_evidence_ref,
        provider_family_ref: input.smoke_target.provider_family_ref,
        provider_instance_ref: input.smoke_target.provider_instance_ref,
        remote_repo_ref: input.smoke_target.remote_repo_ref,
        operation_family: input.smoke_target.operation_family,
        evidence_refs,
        status,
        blockers,
        duplicate_executor_request_detected: duplicate,
        provider_network_call_performed: false,
        credential_resolution_performed: false,
        provider_write_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn request_blockers(
    input: &ProviderLiveReadServerRequestInput,
    duplicate: bool,
) -> Vec<ProviderLiveReadServerRequestBlocker> {
    let mut blockers = Vec::new();
    if duplicate {
        blockers.push(ProviderLiveReadServerRequestBlocker::DuplicateExecutorRequest);
    }
    if input.smoke_target.status != ProviderLiveReadSmokeTargetStatus::Selected {
        blockers.push(ProviderLiveReadServerRequestBlocker::SmokeTargetNotSelected);
    }
    if input.checklist.status
        != ProviderLiveReadSmokeAuthorityChecklistStatus::ReadyForStoppedSmokeRequest
    {
        blockers.push(ProviderLiveReadServerRequestBlocker::ChecklistNotReady);
    }
    if input.smoke_request.status
        != ProviderLiveReadSmokeRequestStatus::StoppedPendingExplicitExecution
    {
        blockers.push(ProviderLiveReadServerRequestBlocker::SmokeRequestNotApprovedForExecution);
    }
    if input.checklist.smoke_target_id != input.smoke_target.smoke_target_id {
        blockers.push(ProviderLiveReadServerRequestBlocker::SmokeTargetMismatch);
    }
    if input.smoke_request.checklist_id != input.checklist.checklist_id {
        blockers.push(ProviderLiveReadServerRequestBlocker::ChecklistMismatch);
    }
    optional_ref_blockers(input, &mut blockers);
    effect_blockers(input, &mut blockers);
    blockers
}

fn optional_ref_blockers(
    input: &ProviderLiveReadServerRequestInput,
    blockers: &mut Vec<ProviderLiveReadServerRequestBlocker>,
) {
    if input.checklist.operator_approval_ref.is_none() {
        blockers.push(ProviderLiveReadServerRequestBlocker::MissingOperatorApprovalRef);
    }
    if input.checklist.network_read_authority_ref.is_none() {
        blockers.push(ProviderLiveReadServerRequestBlocker::MissingNetworkReadAuthorityRef);
    }
    if input.checklist.credential_lease_ref.is_none() {
        blockers.push(ProviderLiveReadServerRequestBlocker::MissingCredentialLeaseRef);
    }
    if input.executor_authority_ref.is_none() {
        blockers.push(ProviderLiveReadServerRequestBlocker::MissingExecutorAuthorityRef);
    }
    if input.command_descriptor_ref.is_none() {
        blockers.push(ProviderLiveReadServerRequestBlocker::MissingCommandDescriptorRef);
    }
    if input.output_evidence_ref.is_none() {
        blockers.push(ProviderLiveReadServerRequestBlocker::MissingOutputEvidenceRef);
    }
    if input.receipt_evidence_ref.is_none() {
        blockers.push(ProviderLiveReadServerRequestBlocker::MissingReceiptEvidenceRef);
    }
    if input.smoke_target.remote_repo_ref.is_none() {
        blockers.push(ProviderLiveReadServerRequestBlocker::MissingRemoteRepoRef);
    }
    if input.smoke_target.operation_family
        != ForgeNetworkExecutionOperationFamily::RepositoryMetadataRefresh
    {
        blockers.push(ProviderLiveReadServerRequestBlocker::UnsupportedOperationFamily);
    }
}

fn effect_blockers(
    input: &ProviderLiveReadServerRequestInput,
    blockers: &mut Vec<ProviderLiveReadServerRequestBlocker>,
) {
    if input.credential_material_present {
        blockers.push(ProviderLiveReadServerRequestBlocker::CredentialMaterialPresent);
    }
    if input.provider_write_requested {
        blockers.push(ProviderLiveReadServerRequestBlocker::ProviderWriteRequested);
    }
    if input.callback_execution_requested {
        blockers.push(ProviderLiveReadServerRequestBlocker::CallbackExecutionRequested);
    }
    if input.interruption_execution_requested {
        blockers.push(ProviderLiveReadServerRequestBlocker::InterruptionExecutionRequested);
    }
    if input.recovery_execution_requested {
        blockers.push(ProviderLiveReadServerRequestBlocker::RecoveryExecutionRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ProviderLiveReadServerRequestBlocker::TaskMutationRequested);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(ProviderLiveReadServerRequestBlocker::RawProviderPayloadRetentionRequested);
    }
}

fn request_status(
    blockers: &[ProviderLiveReadServerRequestBlocker],
    duplicate: bool,
) -> ProviderLiveReadServerRequestStatus {
    if duplicate {
        ProviderLiveReadServerRequestStatus::DuplicateNoop
    } else if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ProviderLiveReadServerRequestBlocker::SmokeTargetNotSelected
                | ProviderLiveReadServerRequestBlocker::ChecklistNotReady
                | ProviderLiveReadServerRequestBlocker::SmokeRequestNotApprovedForExecution
                | ProviderLiveReadServerRequestBlocker::UnsupportedOperationFamily
                | ProviderLiveReadServerRequestBlocker::CredentialMaterialPresent
                | ProviderLiveReadServerRequestBlocker::ProviderWriteRequested
                | ProviderLiveReadServerRequestBlocker::CallbackExecutionRequested
                | ProviderLiveReadServerRequestBlocker::InterruptionExecutionRequested
                | ProviderLiveReadServerRequestBlocker::RecoveryExecutionRequested
                | ProviderLiveReadServerRequestBlocker::TaskMutationRequested
                | ProviderLiveReadServerRequestBlocker::RawProviderPayloadRetentionRequested
        )
    }) {
        ProviderLiveReadServerRequestStatus::Blocked
    } else if blockers.is_empty() {
        ProviderLiveReadServerRequestStatus::ReadyForCommandDescriptor
    } else {
        ProviderLiveReadServerRequestStatus::RepairRequired
    }
}

fn optional_push(values: &mut Vec<String>, value: &Option<String>) {
    if let Some(value) = value {
        values.push(value.clone());
    }
}
