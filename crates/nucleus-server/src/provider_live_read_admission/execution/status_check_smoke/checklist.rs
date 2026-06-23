use super::super::status_check_smoke_types::{
    ProviderLiveReadStatusCheckSmokeChecklistBlocker,
    ProviderLiveReadStatusCheckSmokeChecklistInput,
    ProviderLiveReadStatusCheckSmokeChecklistRecord,
    ProviderLiveReadStatusCheckSmokeChecklistStatus, ProviderLiveReadStatusCheckSmokeTargetStatus,
};

pub fn provider_live_read_status_check_smoke_checklist(
    input: ProviderLiveReadStatusCheckSmokeChecklistInput,
) -> ProviderLiveReadStatusCheckSmokeChecklistRecord {
    let blockers = checklist_blockers(&input);
    let status = checklist_status(&blockers);

    ProviderLiveReadStatusCheckSmokeChecklistRecord {
        checklist_id: format!(
            "provider-live-read-status-check-smoke-checklist:{}",
            input.target.smoke_target_id
        ),
        smoke_target_id: input.target.smoke_target_id,
        remote_repo_ref: input.target.remote_repo_ref,
        pull_request_ref: input.target.pull_request_ref,
        json_fields: input.target.json_fields,
        credential_lease_ref: input.credential_lease_ref,
        network_read_authority_ref: input.network_read_authority_ref,
        payload_policy_ref: input.payload_policy_ref,
        retention_policy_ref: input.retention_policy_ref,
        operator_approval_ref: input.operator_approval_ref,
        checklist_evidence_ref: input.checklist_evidence_ref,
        status,
        blockers,
        provider_network_call_performed: false,
        credential_resolution_performed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn checklist_blockers(
    input: &ProviderLiveReadStatusCheckSmokeChecklistInput,
) -> Vec<ProviderLiveReadStatusCheckSmokeChecklistBlocker> {
    let mut blockers = Vec::new();
    if input.target.status != ProviderLiveReadStatusCheckSmokeTargetStatus::Selected {
        blockers.push(ProviderLiveReadStatusCheckSmokeChecklistBlocker::TargetNotSelected);
    }
    if input.credential_lease_ref.is_none() {
        blockers.push(ProviderLiveReadStatusCheckSmokeChecklistBlocker::MissingCredentialLeaseRef);
    }
    if input.network_read_authority_ref.is_none() {
        blockers
            .push(ProviderLiveReadStatusCheckSmokeChecklistBlocker::MissingNetworkReadAuthorityRef);
    }
    if input.payload_policy_ref.is_none() {
        blockers.push(ProviderLiveReadStatusCheckSmokeChecklistBlocker::MissingPayloadPolicyRef);
    }
    if input.retention_policy_ref.is_none() {
        blockers.push(ProviderLiveReadStatusCheckSmokeChecklistBlocker::MissingRetentionPolicyRef);
    }
    if input.operator_approval_ref.is_none() {
        blockers.push(ProviderLiveReadStatusCheckSmokeChecklistBlocker::MissingOperatorApprovalRef);
    }
    if input.checklist_evidence_ref.is_none() {
        blockers
            .push(ProviderLiveReadStatusCheckSmokeChecklistBlocker::MissingChecklistEvidenceRef);
    }
    if input.credential_material_present {
        blockers.push(ProviderLiveReadStatusCheckSmokeChecklistBlocker::CredentialMaterialPresent);
    }
    if input.provider_network_call_requested {
        blockers
            .push(ProviderLiveReadStatusCheckSmokeChecklistBlocker::ProviderNetworkCallRequested);
    }
    if input.provider_write_requested {
        blockers.push(ProviderLiveReadStatusCheckSmokeChecklistBlocker::ProviderWriteRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ProviderLiveReadStatusCheckSmokeChecklistBlocker::TaskMutationRequested);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(
            ProviderLiveReadStatusCheckSmokeChecklistBlocker::RawProviderPayloadRetentionRequested,
        );
    }
    blockers
}

fn checklist_status(
    blockers: &[ProviderLiveReadStatusCheckSmokeChecklistBlocker],
) -> ProviderLiveReadStatusCheckSmokeChecklistStatus {
    if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            ProviderLiveReadStatusCheckSmokeChecklistBlocker::CredentialMaterialPresent
                | ProviderLiveReadStatusCheckSmokeChecklistBlocker::ProviderNetworkCallRequested
                | ProviderLiveReadStatusCheckSmokeChecklistBlocker::ProviderWriteRequested
                | ProviderLiveReadStatusCheckSmokeChecklistBlocker::TaskMutationRequested
                | ProviderLiveReadStatusCheckSmokeChecklistBlocker::RawProviderPayloadRetentionRequested
        )
    }) {
        ProviderLiveReadStatusCheckSmokeChecklistStatus::Blocked
    } else if blockers
        .contains(&ProviderLiveReadStatusCheckSmokeChecklistBlocker::MissingOperatorApprovalRef)
    {
        ProviderLiveReadStatusCheckSmokeChecklistStatus::ApprovalRequired
    } else if blockers.is_empty() {
        ProviderLiveReadStatusCheckSmokeChecklistStatus::ReadyForStoppedStatusCheckRequest
    } else {
        ProviderLiveReadStatusCheckSmokeChecklistStatus::RepairRequired
    }
}
